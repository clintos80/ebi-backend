require("dotenv").config();

const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const OpenAI = require("openai");
const { google } = require("googleapis");
const chrono = require("chrono-node");
const { DateTime } = require("luxon");
const twilio = require("twilio");

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const twilioClient =
  process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
    ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
    : null;

function escapeXml(unsafe) {
  return String(unsafe ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/* ===============================
   LATENCY TRICK 1: Business cache
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
   LATENCY TRICK 2: In-memory voice session history (per CallSid)
================================= */
const voiceSessionHistory = new Map();
const VOICE_SESSION_TTL_MS = 20 * 60 * 1000;
const voiceSessionExpiry = new Map();

function touchVoiceSession(callSid) {
  voiceSessionExpiry.set(callSid, Date.now() + VOICE_SESSION_TTL_MS);
}
function cleanupExpiredSessions() {
  const now = Date.now();
  for (const [sid, exp] of voiceSessionExpiry.entries()) {
    if (exp <= now) {
      voiceSessionExpiry.delete(sid);
      voiceSessionHistory.delete(sid);
    }
  }
}
setInterval(cleanupExpiredSessions, 60 * 1000).unref();

/* ===============================
   DB helpers
================================= */
async function storeConversation(businessId, userPhone, channel, role, message, callSid = null) {
  const { error } = await supabase.from("conversations").insert([
    { business_id: businessId, user_phone: userPhone, channel, role, message, call_sid: callSid },
  ]);
  if (error) console.error("Store conversation error:", error.message);
}

async function upsertVoiceLead(businessId, callSid, lead, customerPhone) {
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
  };

  const { data, error } = await supabase.from("leads").insert([payload]).select("*").maybeSingle();
  if (error) {
    console.error("SMS lead insert error:", error.message);
    return null;
  }
  return data;
}

/* ===============================
   Google Calendar OAuth + API
================================= */
function getOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URL
  );
}

// Start OAuth (MVP: identify business by its Twilio phone_number in query)
app.get("/auth/google/start", async (req, res) => {
  try {
    let phoneNumber = req.query.phone_number;

    if (!phoneNumber) return res.status(400).send("Missing phone_number");

    // Fix: query params treat "+" as space, normalize it
    phoneNumber = String(phoneNumber).trim().replace(/\s+/g, "");
    if (!phoneNumber.startsWith("+")) phoneNumber = `+${phoneNumber}`;

    console.log("OAuth start phone_number:", phoneNumber);

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
  const base = DateTime.now().setZone(tz || "Australia/Sydney").toJSDate();
  const results = chrono.parse(preferredTime, base);
  if (!results || results.length === 0) return null;

  const d = results[0].start?.date();
  if (!d) return null;

  const start = DateTime.fromJSDate(d).setZone(tz || "Australia/Sydney");
  // Default 1 hour
  const end = start.plus({ hours: 1 });
  return { start, end };
}

async function createCalendarEvent(business, lead, customerPhone) {
  if (!business?.gcal_refresh_token) return { ok: false, reason: "no_refresh_token" };

  const tz = business.timezone || "Australia/Sydney";
  const time = parsePreferredTime(lead.preferred_time, tz);
  if (!time) return { ok: false, reason: "time_unparseable" };

  const oauth2Client = getOAuthClient();
  oauth2Client.setCredentials({ refresh_token: business.gcal_refresh_token });

  const calendar = google.calendar({ version: "v3", auth: oauth2Client });

  const titleBits = [
    lead.customer_name ? lead.customer_name : "New lead",
    lead.job_type ? `- ${lead.job_type}` : "",
  ].join(" ").trim();

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
      summary: titleBits || "New lead",
      description,
      start: { dateTime: time.start.toISO(), timeZone: tz },
      end: { dateTime: time.end.toISO(), timeZone: tz },
    },
  });

  return { ok: true, eventId: event.data.id };
}

async function sendOwnerSms(business, lead, customerPhone) {
  if (!twilioClient) return { ok: false, reason: "twilio_not_configured" };
  if (!business?.owner_phone) return { ok: false, reason: "no_owner_phone" };
  if (!process.env.TWILIO_FROM_NUMBER) return { ok: false, reason: "no_from_number" };

  const msg = [
    `New lead (${business.business_name})`,
    `Name: ${lead.customer_name || "-"}`,
    `Phone: ${customerPhone || "-"}`,
    `Job: ${lead.job_type || "-"}`,
    `Urgency: ${lead.urgency || "-"}`,
    `Suburb: ${lead.suburb || "-"}`,
    `Address: ${lead.address || "-"}`,
    `Pref time: ${lead.preferred_time || "-"}`,
  ].join("\n");

  await twilioClient.messages.create({
    from: process.env.TWILIO_FROM_NUMBER,
    to: business.owner_phone,
    body: msg,
  });

  return { ok: true };
}

// Mark lead as "notified=true" atomically, only once (voice)
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
  return data; // null means already claimed / not found
}

async function updateLeadEvent(businessId, callSid, calendarEventId, notesAppend) {
  const { error } = await supabase
    .from("leads")
    .update({
      calendar_event_id: calendarEventId || null,
      notes: notesAppend || null,
    })
    .eq("business_id", businessId)
    .eq("call_sid", callSid);

  if (error) console.error("Update lead event error:", error.message);
}

/* ===============================
   OpenAI strict JSON schema
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
Phone is known by the system; keep customer_phone as null.

Style rules:
- 1–2 short sentences.
- Ask for at most ONE missing field per turn.
- Do not repeat the same question if you already asked it in the last assistant message.
- If lead_ready=true: confirm details briefly and say someone will confirm shortly.

lead_ready=true only when you have:
customer_name + job_type + urgency + preferred_time + (suburb OR address).`;

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    response_format: {
      type: "json_schema",
      json_schema: LEAD_REPLY_SCHEMA,
    },
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
   Routes
================================= */
app.get("/", (req, res) => res.send("Ebi SaaS backend is running"));

app.post("/voice", async (req, res) => {
  const toNumber = req.body.To;
  const business = await getBusinessByPhoneNumber(toNumber);

  if (!business) {
    return res.type("text/xml").send(`
<Response><Say>Sorry, this number is not configured.</Say></Response>`);
  }

  return res.type("text/xml").send(`
<Response>
  <Say voice="Polly.Joanna-Neural">
    Hello, thank you for calling ${escapeXml(business.business_name)}. How can I help you today?
  </Say>
  <Gather input="speech" action="/process" method="POST" timeout="5" speechTimeout="auto" />
</Response>`);
});

app.post("/process", async (req, res) => {
  try {
    const toNumber = req.body.To;
    const fromNumber = req.body.From;
    const callSid = req.body.CallSid;
    const userSpeech = req.body.SpeechResult;

    const business = await getBusinessByPhoneNumber(toNumber);
    if (!business) {
      return res.type("text/xml").send(`
<Response><Say>Sorry, this number is not configured.</Say></Response>`);
    }

    if (!userSpeech) {
      return res.type("text/xml").send(`
<Response>
  <Say voice="Polly.Joanna-Neural">Sorry, I didn’t catch that—could you say it again?</Say>
  <Gather input="speech" action="/process" method="POST" timeout="5" speechTimeout="auto" />
</Response>`);
    }

    const sessionKey = callSid || `voice:${fromNumber}`;
    const currentHistory = voiceSessionHistory.get(sessionKey) || [];
    touchVoiceSession(sessionKey);

    void storeConversation(business.id, fromNumber, "voice", "user", userSpeech, callSid);

    const assistantJson = await getAssistantJson(business.system_prompt, currentHistory, userSpeech);
    const reply = (assistantJson.reply || "").trim() || "Thanks—what suburb are you in?";
    const leadReady = Boolean(assistantJson.lead_ready);
    const lead = assistantJson.lead || {};

    const nextHistory = [
      ...currentHistory,
      { role: "user", message: userSpeech },
      { role: "assistant", message: reply },
    ].slice(-10);
    voiceSessionHistory.set(sessionKey, nextHistory);

    void storeConversation(business.id, fromNumber, "voice", "assistant", reply, callSid);

    // Upsert lead continuously per call
    void upsertVoiceLead(business.id, callSid, { ...lead, lead_ready: leadReady }, fromNumber);

    // If lead becomes ready, notify once + create calendar event (if calendar connected)
    if (leadReady && callSid) {
      // Claim notification once (atomic)
      const claimed = await claimVoiceNotification(business.id, callSid);
      if (claimed) {
        // Create calendar event (best effort)
        const cal = await createCalendarEvent(business, lead, fromNumber);

        if (cal.ok) {
          await updateLeadEvent(business.id, callSid, cal.eventId, claimed.notes || null);
        } else if (cal.reason === "time_unparseable") {
          await updateLeadEvent(
            business.id,
            callSid,
            null,
            `${(claimed.notes || "").trim()}\nPreferred time unclear: ${lead.preferred_time || ""}`.trim()
          );
        }

        // SMS notify (best effort)
        await sendOwnerSms(business, lead, fromNumber);
      }
    }

    return res.type("text/xml").send(`
<Response>
  <Say voice="Polly.Joanna-Neural">${escapeXml(reply)}</Say>
  <Gather input="speech" action="/process" method="POST" timeout="5" speechTimeout="auto" />
</Response>`);
  } catch (err) {
    console.error("Voice error:", err.message);
    return res.type("text/xml").send(`
<Response><Say>Sorry, something went wrong.</Say></Response>`);
  }
});

app.post("/sms", async (req, res) => {
  try {
    const toNumber = req.body.To;
    const fromNumber = req.body.From;
    const userMessage = req.body.Body;

    const business = await getBusinessByPhoneNumber(toNumber);
    if (!business) {
      return res.type("text/xml").send(`
<Response><Message>Sorry, this number is not configured.</Message></Response>`);
    }

    if (!userMessage) {
      return res.type("text/xml").send(`
<Response><Message>Sorry, I didn’t catch that.</Message></Response>`);
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

    // Create one lead record when ready, notify + calendar
    if (leadReady) {
      const newLead = await insertSmsLead(business.id, fromNumber, lead);
      if (newLead) {
        await sendOwnerSms(business, lead, fromNumber);
        // Calendar (best effort)
        const cal = await createCalendarEvent(business, lead, fromNumber);
        if (cal.ok) {
          await supabase
            .from("leads")
            .update({ calendar_event_id: cal.eventId, notified: true })
            .eq("id", newLead.id);
        } else {
          await supabase
            .from("leads")
            .update({ notified: true })
            .eq("id", newLead.id);
        }
      }
    }

    return res.type("text/xml").send(`
<Response><Message>${escapeXml(reply)}</Message></Response>`);
  } catch (err) {
    console.error("SMS error:", err.message);
    return res.type("text/xml").send(`
<Response><Message>Sorry, something went wrong.</Message></Response>`);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));