require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const OpenAI = require("openai");
const { google } = require("googleapis");
const chrono = require("chrono-node");
const { DateTime } = require("luxon");
const twilio = require("twilio");
const Stripe = require("stripe");

const app = express();

app.use(
  cors({
    origin: [
      "http://localhost:3000",
      "https://ebi-dashboard.vercel.app",
    ],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    credentials: false,
  })
);

app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  if (req.originalUrl === "/billing/webhook") {
    next();
  } else {
    express.json()(req, res, next);
  }
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const twilioClient =
  process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
    ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
    : null;

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);    

/* ===============================
   Utilities
================================= */
function escapeXml(unsafe) {
  return String(unsafe ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function renderTemplate(template, vars) {
  let output = template || "";
  for (const [key, value] of Object.entries(vars)) {
    output = output.replaceAll(`{{${key}}}`, String(value ?? ""));
  }
  return output;
}

/* ===============================
   Business cache
================================= */
const BUSINESS_CACHE_TTL_MS = 10 * 60 * 1000;
const businessCache = new Map();

async function getBusinessByPhoneNumber(toNumber) {
  const cached = businessCache.get(toNumber);
  if (cached && cached.expiresAt > Date.now()) return cached.business;

  const { data, error } = await supabase
    .from("businesses")
    .select("*")
    .eq("phone_number", toNumber)
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("Business lookup error:", error.message);
    return null;
  }

  if (data) {
    businessCache.set(toNumber, {
      business: data,
      expiresAt: Date.now() + BUSINESS_CACHE_TTL_MS,
    });
  }

  return data;
}

/* ===============================
   Voice session memory
================================= */
const voiceSessionHistory = new Map();
const VOICE_SESSION_TTL_MS = 20 * 60 * 1000;
const voiceSessionExpiry = new Map();

function touchVoiceSession(callSid) {
  voiceSessionExpiry.set(callSid, Date.now() + VOICE_SESSION_TTL_MS);
}

const callState = new Map();

function getCallState(callSid) {
  if (!callSid) return { lastFiller: "", silenceCount: 0 };
  if (!callState.has(callSid)) {
    callState.set(callSid, { lastFiller: "", silenceCount: 0 });
  }
  return callState.get(callSid);
}

function pickFiller(callSid, userSpeech) {
  const state = getCallState(callSid);
  const text = (userSpeech || "").trim().toLowerCase();

  const looksLikeShortAnswer = text.length <= 18;
  const looksLikeLocation =
    /\b(i'?m in|im in|in|at)\b/.test(text) || /^[a-z\s-]{3,25}$/.test(text);

  const shortAck = ["Perfect, thanks.", "Got it.", "Okay, noted.", "Great, thanks."];
  const thinking = ["Alright — one sec.", "Thanks — just a moment.", "Okay — give me a second."];

  const pool = looksLikeShortAnswer || looksLikeLocation ? shortAck : thinking;

  let chosen = pool[Math.floor(Math.random() * pool.length)];
  if (chosen === state.lastFiller && pool.length > 1) {
    chosen = pool.find((x) => x !== state.lastFiller) || chosen;
  }

  state.lastFiller = chosen;
  return chosen;
}

function cleanupExpiredSessions() {
  const now = Date.now();
  for (const [sid, exp] of voiceSessionExpiry.entries()) {
    if (exp <= now) {
      voiceSessionExpiry.delete(sid);
      voiceSessionHistory.delete(sid);
      callState.delete(sid);
    }
  }
}
setInterval(cleanupExpiredSessions, 60 * 1000).unref();

/* ===============================
   DB helpers
================================= */
async function storeConversation(businessId, userPhone, channel, role, message, callSid = null) {
  const { error } = await supabase.from("conversations").insert([
    {
      business_id: businessId,
      user_phone: userPhone,
      channel,
      role,
      message,
      call_sid: callSid,
    },
  ]);

  if (error) console.error("Store conversation error:", error.message);
}

async function upsertVoiceLead(businessId, callSid, lead, customerPhone, entryType = "direct") {
  if (!callSid) return;

  const payload = {
    business_id: businessId,
    source: "voice",
    call_sid: callSid,
    customer_phone: customerPhone || lead.customer_phone || null,
    customer_name: lead.customer_name || null,
    suburb: lead.suburb || null,
    address: lead.address || null,
    job_type: lead.job_type || null,
    urgency: lead.urgency || null,
    preferred_time: lead.preferred_time || null,
    notes: lead.notes || null,
    status: lead.status || (lead.lead_ready ? "new" : "in_progress"),
    lead_ready: Boolean(lead.lead_ready),
    entry_type: entryType,
  };

  const { error } = await supabase
    .from("leads")
    .upsert(payload, { onConflict: "business_id,call_sid" });

  if (error) console.error("Lead upsert error:", error.message);
}

async function insertSmsLead(businessId, customerPhone, lead) {
  const payload = {
    business_id: businessId,
    source: "sms",
    call_sid: null,
    customer_phone: customerPhone || lead.customer_phone || null,
    customer_name: lead.customer_name || null,
    suburb: lead.suburb || null,
    address: lead.address || null,
    job_type: lead.job_type || null,
    urgency: lead.urgency || null,
    preferred_time: lead.preferred_time || null,
    notes: lead.notes || null,
    status: lead.status || "new",
    lead_ready: Boolean(lead.lead_ready),
    entry_type: "direct",
  };

  const { data, error } = await supabase
    .from("leads")
    .insert([payload])
    .select("*")
    .maybeSingle();

  if (error) {
    console.error("SMS lead insert error:", error.message);
    return null;
  }

  return data;
}

async function claimVoiceNotification(businessId, callSid) {
  const { data, error } = await supabase
    .from("leads")
    .update({ notified: true })
    .eq("business_id", businessId)
    .eq("call_sid", callSid)
    .eq("notified", false)
    .select("*")
    .maybeSingle();

  if (error) {
    console.error("Claim notify error:", error.message);
    return null;
  }

  return data;
}

async function updateLeadCalendarInfo(businessId, callSid, calendarEventId, notesAppend) {
  const patch = {};
  if (calendarEventId !== undefined) patch.calendar_event_id = calendarEventId;
  if (notesAppend !== undefined) patch.notes = notesAppend;

  const { error } = await supabase
    .from("leads")
    .update(patch)
    .eq("business_id", businessId)
    .eq("call_sid", callSid);

  if (error) console.error("Update lead calendar info error:", error.message);
}

/* ===============================
   OpenAI structured extraction
================================= */
const LEAD_REPLY_SCHEMA = {
  name: "lead_reply",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["reply", "lead_ready", "lead"],
    properties: {
      reply: { type: "string" },
      lead_ready: { type: "boolean" },
      lead: {
        type: "object",
        additionalProperties: false,
        required: [
          "customer_name",
          "customer_phone",
          "suburb",
          "address",
          "job_type",
          "urgency",
          "preferred_time",
          "notes",
          "status",
        ],
        properties: {
          customer_name: { anyOf: [{ type: "string" }, { type: "null" }] },
          customer_phone: { anyOf: [{ type: "string" }, { type: "null" }] },
          suburb: { anyOf: [{ type: "string" }, { type: "null" }] },
          address: { anyOf: [{ type: "string" }, { type: "null" }] },
          job_type: { anyOf: [{ type: "string" }, { type: "null" }] },
          urgency: {
            anyOf: [
              { type: "string", enum: ["emergency", "today", "this_week", "quote", "unknown"] },
              { type: "null" },
            ],
          },
          preferred_time: { anyOf: [{ type: "string" }, { type: "null" }] },
          notes: { anyOf: [{ type: "string" }, { type: "null" }] },
          status: {
            anyOf: [
              { type: "string", enum: ["new", "in_progress", "booked", "closed"] },
              { type: "null" },
            ],
          },
        },
      },
    },
  },
};

async function getAssistantJson(systemPrompt, history, userInput) {
  const cleanedHistory = (history || [])
    .filter((m) => m && m.role && m.message)
    .map((m) => ({ role: m.role, content: m.message }));

  const system = `${systemPrompt}

You are taking inbound calls/SMS for an Australian electrician.

Capture these fields naturally:
- customer_name
- suburb
- address
- job_type
- urgency
- preferred_time
Caller phone is known by the system; keep customer_phone as null.

Style rules:
- 1–2 short sentences.
- Ask for at most ONE missing field per turn.
- Do not repeat the same question if you already asked it in the last assistant message.
- If the caller doesn't know the fault, ask symptom-based options like power outage, tripping switch, flickering lights, sparks, or burning smell.
- If lead_ready=true: confirm briefly and say someone will confirm shortly.

lead_ready=true only when you have:
customer_name + job_type + urgency + preferred_time + (suburb OR address).`;

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    response_format: { type: "json_schema", json_schema: LEAD_REPLY_SCHEMA },
    messages: [
      { role: "system", content: system },
      ...cleanedHistory,
      { role: "user", content: userInput },
    ],
  });

  const raw = completion.choices?.[0]?.message?.content || "{}";
  return JSON.parse(raw);
}

/* ===============================
   Google Calendar
================================= */
function getOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URL
  );
}

app.get("/auth/google/start", async (req, res) => {
  try {
    let phoneNumber = req.query.phone_number;
    if (!phoneNumber) return res.status(400).send("Missing phone_number");

    phoneNumber = String(phoneNumber).trim().replace(/\s+/g, "");
    if (!phoneNumber.startsWith("+")) phoneNumber = `+${phoneNumber}`;

    const business = await getBusinessByPhoneNumber(phoneNumber);
    if (!business) return res.status(404).send("Business not found");

    const oauth2Client = getOAuthClient();
    const url = oauth2Client.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: ["https://www.googleapis.com/auth/calendar.events"],
      state: business.id,
    });

    return res.redirect(url);
  } catch (e) {
    console.error("OAuth start error:", e.message);
    return res.status(500).send("OAuth start failed");
  }
});

app.get("/auth/google/callback", async (req, res) => {
  try {
    const code = req.query.code;
    const businessId = req.query.state;
    if (!code || !businessId) return res.status(400).send("Missing code/state");

    const oauth2Client = getOAuthClient();
    const { tokens } = await oauth2Client.getToken(code);

    if (!tokens.refresh_token) {
      return res.status(400).send("No refresh token returned. Try again with consent.");
    }

    const { error } = await supabase
      .from("businesses")
      .update({
        gcal_refresh_token: tokens.refresh_token,
        gcal_calendar_id: "primary",
      })
      .eq("id", businessId);

    if (error) {
      console.error("Store refresh token error:", error.message);
      return res.status(500).send("Failed to store token");
    }

    return res.send("Google Calendar connected. You can close this tab.");
  } catch (e) {
    console.error("OAuth callback error:", e.message);
    return res.status(500).send("OAuth callback failed");
  }
});

function parsePreferredTime(preferredTime, tz) {
  if (!preferredTime) return null;

  const zone = tz || "Australia/Sydney";
  const base = DateTime.now().setZone(zone).toJSDate();
  const results = chrono.parse(preferredTime, base);

  if (!results || results.length === 0) return null;

  const d = results[0].start?.date();
  if (!d) return null;

  const start = DateTime.fromJSDate(d).setZone(zone);
  const end = start.plus({ hours: 1 });

  return { start, end, zone };
}

async function createCalendarEventBestEffort(business, lead, customerPhone) {
  try {
    if (!business?.gcal_refresh_token) return { ok: false, reason: "no_refresh_token" };

    const tz = business.timezone || "Australia/Sydney";
    const time = parsePreferredTime(lead.preferred_time, tz);
    if (!time) return { ok: false, reason: "time_unparseable" };

    const oauth2Client = getOAuthClient();
    oauth2Client.setCredentials({ refresh_token: business.gcal_refresh_token });

    const calendar = google.calendar({ version: "v3", auth: oauth2Client });

    const title = `${lead.customer_name || "New lead"}${lead.job_type ? ` - ${lead.job_type}` : ""}`.trim();

    const description = [
      `Phone: ${customerPhone || ""}`,
      `Name: ${lead.customer_name || ""}`,
      `Job: ${lead.job_type || ""}`,
      `Urgency: ${lead.urgency || ""}`,
      `Suburb: ${lead.suburb || ""}`,
      `Address: ${lead.address || ""}`,
      `Preferred time: ${lead.preferred_time || ""}`,
      `Notes: ${lead.notes || ""}`,
    ].join("\n");

    const event = await calendar.events.insert({
      calendarId: business.gcal_calendar_id || "primary",
      requestBody: {
        summary: title || "New lead",
        description,
        start: { dateTime: time.start.toISO(), timeZone: time.zone },
        end: { dateTime: time.end.toISO(), timeZone: time.zone },
      },
    });

    return { ok: true, eventId: event.data.id };
  } catch (e) {
    console.error("Calendar create failed:", e.message);
    return { ok: false, reason: "calendar_error" };
  }
}

/* ===============================
   Twilio SMS
================================= */
async function sendOwnerSmsBestEffort(business, lead, customerPhone) {
  try {
    if (!twilioClient) return { ok: false, reason: "twilio_not_configured" };
    if (!business?.owner_phone) return { ok: false, reason: "no_owner_phone" };
    if (!process.env.TWILIO_FROM_NUMBER) return { ok: false, reason: "no_from_number" };

    const msg = [
      `New lead (${business.business_name})`,
      `Name: ${lead.customer_name || "-"}`,
      `Caller: ${customerPhone || "-"}`,
      `Job: ${lead.job_type || "-"}`,
      `Urgency: ${lead.urgency || "-"}`,
      `Suburb: ${lead.suburb || "-"}`,
      `Address: ${lead.address || "-"}`,
      `Preferred: ${lead.preferred_time || "-"}`,
    ].join("\n");

    await twilioClient.messages.create({
      from: process.env.TWILIO_FROM_NUMBER,
      to: business.owner_phone,
      body: msg,
    });

    return { ok: true };
  } catch (e) {
    console.error("Owner SMS failed:", e.message);
    return { ok: false, reason: "sms_error" };
  }
}

async function sendRecoverySmsBestEffort(business, callerPhone) {
  try {
    if (!twilioClient) return { ok: false, reason: "twilio_not_configured" };
    if (!process.env.TWILIO_FROM_NUMBER) return { ok: false, reason: "no_from_number" };
    if (!callerPhone) return { ok: false, reason: "no_caller_phone" };

    const template =
      business.missed_call_sms_template ||
      "Hi, this is Ebi from {{business_name}}. Sorry we missed your call. What electrical issue are you experiencing?";

    const body = renderTemplate(template, {
      business_name: business.business_name || "our team",
    });

    await twilioClient.messages.create({
      from: process.env.TWILIO_FROM_NUMBER,
      to: callerPhone,
      body,
    });

    return { ok: true };
  } catch (e) {
    console.error("Recovery SMS failed:", e.message);
    return { ok: false, reason: "recovery_sms_error" };
  }
}

/* ===============================
   Voice post-actions
================================= */
async function runPostLeadActionsVoice({ business, callSid, lead, fromNumber }) {
  try {
    const claimed = await claimVoiceNotification(business.id, callSid);
    if (!claimed) return;

    const cal = await createCalendarEventBestEffort(business, lead, fromNumber);
    if (cal.ok) {
      await updateLeadCalendarInfo(business.id, callSid, cal.eventId, claimed.notes ?? undefined);
    } else if (cal.reason === "time_unparseable") {
      const append = `${(claimed.notes || "").trim()}\nPreferred time unclear: ${lead.preferred_time || ""}`.trim();
      await updateLeadCalendarInfo(business.id, callSid, undefined, append);
    }

    await sendOwnerSmsBestEffort(business, lead, fromNumber);
  } catch (e) {
    console.error("Post lead actions (voice) failed:", e.message);
  }
}

async function getBusinessForBilling(userId) {
  const { data, error } = await supabase
    .from("businesses")
    .select("*")
    .eq("owner_user_id", userId)
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("Billing business lookup error:", error.message);
    return null;
  }

  return data;
}

function getPlanKeyFromPriceId(priceId) {
  if (priceId === process.env.STRIPE_PRICE_PRO) return "pro";
  return "starter";
}

function toIsoFromUnix(seconds) {
  if (!seconds) return null;
  return new Date(seconds * 1000).toISOString();
}

async function updateBusinessSubscriptionByCustomerId(customerId, patch) {
  const { error } = await supabase
    .from("businesses")
    .update(patch)
    .eq("stripe_customer_id", customerId);

  if (error) {
    console.error("Update business subscription by customer error:", error.message);
  }
}

async function updateBusinessSubscriptionByBusinessId(businessId, patch) {
  const { error } = await supabase
    .from("businesses")
    .update(patch)
    .eq("id", businessId);

  if (error) {
    console.error("Update business subscription by business error:", error.message);
  }
}

/* ===============================
   Routes
================================= */
app.get("/", (req, res) => {
  res.send("Ebi backend is running");
});

/* ========= VOICE ENTRY =========
   Supports both:
   - direct calls to Twilio number
   - forwarded calls from electrician's own number
================================= */
app.post("/voice", async (req, res) => {
  const toNumber = req.body.To;
  const business = await getBusinessByPhoneNumber(toNumber);

  if (!business) {
    return res.type("text/xml").send(`
<Response>
  <Say>Sorry, this number is not configured.</Say>
</Response>`);
  }

  return res.type("text/xml").send(`
<Response>
  <Say voice="Polly.Joanna-Neural">
    Hello, thank you for calling ${escapeXml(business.business_name)}. How can I help you today?
  </Say>
  <Gather input="speech" action="/process" method="POST" timeout="7" speechTimeout="auto" actionOnEmptyResult="true" />
</Response>`);
});

/* ========= FAST STEP ========= */
app.post("/process", async (req, res) => {
  try {
    const toNumber = req.body.To;
    const fromNumber = req.body.From;
    const callSid = req.body.CallSid;
    const userSpeech = req.body.SpeechResult;

    const business = await getBusinessByPhoneNumber(toNumber);
    if (!business) {
      return res.type("text/xml").send(`
<Response>
  <Say>Sorry, this number is not configured.</Say>
</Response>`);
    }

    const state = getCallState(callSid);

    if (!userSpeech) {
      state.silenceCount += 1;

      const prompt =
        state.silenceCount === 1
          ? "No worries — take your time. Could you say that again?"
          : state.silenceCount === 2
          ? "It’s a bit hard to hear — could you repeat that once more?"
          : "No problem — I’ll send you an SMS to continue. Goodbye.";

      if (state.silenceCount >= 3) {
        return res.type("text/xml").send(`
<Response>
  <Say voice="Polly.Joanna-Neural">${escapeXml(prompt)}</Say>
  <Hangup/>
</Response>`);
      }

      return res.type("text/xml").send(`
<Response>
  <Say voice="Polly.Joanna-Neural">${escapeXml(prompt)}</Say>
  <Gather input="speech" action="/process" method="POST" timeout="7" speechTimeout="auto" actionOnEmptyResult="true" />
</Response>`);
    }

    state.silenceCount = 0;

    void storeConversation(business.id, fromNumber, "voice", "user", userSpeech, callSid);

    const sessionKey = callSid || `voice:${fromNumber}`;
    const currentHistory = voiceSessionHistory.get(sessionKey) || [];
    touchVoiceSession(sessionKey);

    const nextHistory = [...currentHistory, { role: "user", message: userSpeech }].slice(-10);
    voiceSessionHistory.set(sessionKey, nextHistory);

    const filler = pickFiller(callSid, userSpeech);

    return res.type("text/xml").send(`
<Response>
  <Say voice="Polly.Joanna-Neural">${escapeXml(filler)}</Say>
  <Redirect method="POST">/process2</Redirect>
</Response>`);
  } catch (err) {
    console.error("Voice /process error:", err.message);
    return res.type("text/xml").send(`
<Response>
  <Say>Sorry, something went wrong.</Say>
</Response>`);
  }
});

/* ========= AI STEP ========= */
app.post("/process2", async (req, res) => {
  try {
    const toNumber = req.body.To;
    const fromNumber = req.body.From;
    const callSid = req.body.CallSid;
    const forwardedFrom = req.body.ForwardedFrom || null;

    const business = await getBusinessByPhoneNumber(toNumber);
    if (!business) {
      return res.type("text/xml").send(`
<Response>
  <Say>Sorry, this number is not configured.</Say>
</Response>`);
    }

    const sessionKey = callSid || `voice:${fromNumber}`;
    const currentHistory = voiceSessionHistory.get(sessionKey) || [];
    touchVoiceSession(sessionKey);

    const lastUser = [...currentHistory].reverse().find((m) => m.role === "user");
    const userSpeech = lastUser?.message;

    if (!userSpeech) {
      return res.type("text/xml").send(`
<Response>
  <Say voice="Polly.Joanna-Neural">Sorry—could you repeat that?</Say>
  <Gather input="speech" action="/process" method="POST" timeout="7" speechTimeout="auto" actionOnEmptyResult="true" />
</Response>`);
    }

    const assistantJson = await getAssistantJson(business.system_prompt, currentHistory, userSpeech);

    const reply = (assistantJson.reply || "").trim() || "Thanks—what suburb are you in?";
    const leadReady = Boolean(assistantJson.lead_ready);
    const lead = assistantJson.lead || {};
    const entryType = forwardedFrom ? "forwarded" : "direct";

    const nextHistory = [...currentHistory, { role: "assistant", message: reply }].slice(-10);
    voiceSessionHistory.set(sessionKey, nextHistory);

    void storeConversation(business.id, fromNumber, "voice", "assistant", reply, callSid);

    void upsertVoiceLead(
      business.id,
      callSid,
      { ...lead, lead_ready: leadReady },
      fromNumber,
      entryType
    );

    res.type("text/xml").send(`
<Response>
  <Say voice="Polly.Joanna-Neural">${escapeXml(reply)}</Say>
  <Gather input="speech" action="/process" method="POST" timeout="7" speechTimeout="auto" actionOnEmptyResult="true" />
</Response>`);

    if (leadReady && callSid) {
      void runPostLeadActionsVoice({ business, callSid, lead, fromNumber });
    }
  } catch (err) {
    console.error("Voice /process2 error:", err.message);
    return res.type("text/xml").send(`
<Response>
  <Say>Sorry, something went wrong.</Say>
</Response>`);
  }
});

/* ========= CALL STATUS =========
   Send recovery SMS if call ended without a completed lead
================================= */
app.post("/voice-status", async (req, res) => {
  try {
    const callSid = req.body.CallSid;
    const callStatus = req.body.CallStatus;
    const toNumber = req.body.To;
    const fromNumber = req.body.From;

    if (!callSid || callStatus !== "completed") {
      return res.status(200).send("ok");
    }

    const business = await getBusinessByPhoneNumber(toNumber);
    if (!business) {
      return res.status(200).send("ok");
    }

    if (!business.missed_call_sms_enabled) {
      return res.status(200).send("ok");
    }

    const { data: lead, error } = await supabase
      .from("leads")
      .select("id,lead_ready,recovery_sms_sent")
      .eq("business_id", business.id)
      .eq("call_sid", callSid)
      .limit(1)
      .maybeSingle();

    if (error) {
      console.error("Voice status lead lookup error:", error.message);
      return res.status(200).send("ok");
    }

    if (!lead) {
      return res.status(200).send("ok");
    }

    if (lead.lead_ready || lead.recovery_sms_sent) {
      return res.status(200).send("ok");
    }

    await sendRecoverySmsBestEffort(business, fromNumber);

    await supabase
      .from("leads")
      .update({ recovery_sms_sent: true })
      .eq("id", lead.id);

    return res.status(200).send("ok");
  } catch (e) {
    console.error("Voice status error:", e.message);
    return res.status(200).send("ok");
  }
});

/* ========= SMS ========= */
app.post("/sms", async (req, res) => {
  try {
    const toNumber = req.body.To;
    const fromNumber = req.body.From;
    const userMessage = req.body.Body;

    const business = await getBusinessByPhoneNumber(toNumber);
    if (!business) {
      return res.type("text/xml").send(`
<Response>
  <Message>Sorry, this number is not configured.</Message>
</Response>`);
    }

    if (!userMessage) {
      return res.type("text/xml").send(`
<Response>
  <Message>Sorry, I didn’t catch that.</Message>
</Response>`);
    }

    void storeConversation(business.id, fromNumber, "sms", "user", userMessage, null);

    const { data: smsHistory } = await supabase
      .from("conversations")
      .select("role, message")
      .eq("business_id", business.id)
      .eq("user_phone", fromNumber)
      .order("created_at", { ascending: true })
      .limit(12);

    const assistantJson = await getAssistantJson(business.system_prompt, smsHistory || [], userMessage);

    const reply = (assistantJson.reply || "").trim() || "Thanks—what suburb are you in?";
    const leadReady = Boolean(assistantJson.lead_ready);
    const lead = assistantJson.lead || {};

    void storeConversation(business.id, fromNumber, "sms", "assistant", reply, null);

    res.type("text/xml").send(`
<Response>
  <Message>${escapeXml(reply)}</Message>
</Response>`);

    if (leadReady) {
      void sendOwnerSmsBestEffort(business, lead, fromNumber);
      void createCalendarEventBestEffort(business, lead, fromNumber);
      void insertSmsLead(business.id, fromNumber, {
        ...lead,
        lead_ready: true,
      });
    }
  } catch (err) {
    console.error("SMS error:", err.message);
    return res.type("text/xml").send(`
<Response>
  <Message>Sorry, something went wrong.</Message>
</Response>`);
  }
});

app.post(
  "/billing/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    let event;

    try {
      const signature = req.headers["stripe-signature"];

      event = stripe.webhooks.constructEvent(
        req.body,
        signature,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("Stripe webhook signature verification failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
      switch (event.type) {
        case "checkout.session.completed": {
          const session = event.data.object;

          if (session.mode === "subscription") {
            const businessId = session.metadata?.business_id || null;
            const customerId = session.customer || null;
            const subscriptionId = session.subscription || null;
            const planKey = session.metadata?.plan_key || "starter";
            const billingEmail =
              session.customer_details?.email || session.customer_email || null;

            if (businessId) {
              await updateBusinessSubscriptionByBusinessId(businessId, {
                stripe_customer_id: customerId,
                stripe_subscription_id: subscriptionId,
                billing_email: billingEmail,
                plan_key: planKey,
              });
            }
          }

          break;
        }

        case "customer.subscription.created":
        case "customer.subscription.updated": {
          const subscription = event.data.object;

          const customerId = subscription.customer;
          const subscriptionId = subscription.id;
          const status = subscription.status;
          const currentPeriodEnd = toIsoFromUnix(subscription.current_period_end);

          const priceId =
            subscription.items?.data?.[0]?.price?.id || null;

          const planKey = getPlanKeyFromPriceId(priceId);

          await updateBusinessSubscriptionByCustomerId(customerId, {
            stripe_subscription_id: subscriptionId,
            subscription_status: status,
            plan_key: planKey,
            current_period_end: currentPeriodEnd,
          });

          break;
        }

        case "customer.subscription.deleted": {
          const subscription = event.data.object;

          await updateBusinessSubscriptionByCustomerId(subscription.customer, {
            stripe_subscription_id: subscription.id,
            subscription_status: "canceled",
            current_period_end: toIsoFromUnix(subscription.current_period_end),
          });

          break;
        }

        case "invoice.payment_failed": {
          const invoice = event.data.object;

          if (invoice.customer) {
            await updateBusinessSubscriptionByCustomerId(invoice.customer, {
              subscription_status: "past_due",
            });
          }

          break;
        }

        default:
          break;
      }

      return res.json({ received: true });
    } catch (err) {
      console.error("Stripe webhook handler error:", err.message);
      return res.status(500).json({ error: "Webhook handler failed" });
    }
  }
);

app.post("/billing/create-checkout-session", async (req, res) => {
  try {
    const { userId, planKey } = req.body;

    if (!userId || !planKey) {
      return res.status(400).json({ error: "Missing userId or planKey" });
    }

    if (!["starter", "pro"].includes(planKey)) {
      return res.status(400).json({ error: "Invalid planKey" });
    }

    const business = await getBusinessForBilling(userId);
    if (!business) {
      return res.status(404).json({ error: "Business not found" });
    }

    const priceId =
      planKey === "pro"
        ? process.env.STRIPE_PRICE_PRO
        : process.env.STRIPE_PRICE_STARTER;

    if (!priceId) {
      return res.status(500).json({ error: "Missing Stripe price configuration" });
    }

    let customerId = business.stripe_customer_id;

    if (!customerId) {
      const customer = await stripe.customers.create({
        email: business.billing_email || undefined,
        name: business.business_name || undefined,
        metadata: {
          business_id: business.id,
          owner_user_id: userId,
        },
      });

      customerId = customer.id;

      await supabase
        .from("businesses")
        .update({ stripe_customer_id: customerId })
        .eq("id", business.id);
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      success_url: `${process.env.APP_BASE_URL}/dashboard/billing?success=true`,
      cancel_url: `${process.env.APP_BASE_URL}/dashboard/billing?canceled=true`,
      metadata: {
        business_id: business.id,
        owner_user_id: userId,
        plan_key: planKey,
      },
    });

    return res.json({ url: session.url });
  } catch (error) {
    console.error("Create checkout session error:", error.message);
    return res.status(500).json({ error: "Failed to create checkout session" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});