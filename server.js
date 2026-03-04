require("dotenv").config();

const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const OpenAI = require("openai");

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ===============================
   LATENCY TRICK 1: Business cache
================================= */
const BUSINESS_CACHE_TTL_MS = 10 * 60 * 1000; // 10 mins
const businessCache = new Map(); // toNumber -> { business, expiresAt }

/* ===============================
   LATENCY TRICK 2: In-memory voice session history (per CallSid)
================================= */
const voiceSessionHistory = new Map(); // callSid -> [{role, message}]
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
   Helpers
================================= */

function escapeXml(unsafe) {
  return String(unsafe ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

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

  const { error } = await supabase.from("leads").insert([payload]);
  if (error) console.error("SMS lead insert error:", error.message);
}

/* ===============================
   OpenAI: STRICT JSON output
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

Goal: capture these fields naturally:
- customer_name
- suburb
- address
- job_type
- urgency
- preferred_time
Caller phone is already known by the system; you may keep customer_phone as null.

Style rules (critical):
- Sound natural and human.
- Keep reply to 1–2 short sentences.
- Ask for at most ONE missing field per turn.
- Do NOT repeat the same question if you already asked it in the last assistant message.
- If the caller is vague, ask a single clarifying question.

Set lead_ready=true only when you have:
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

  // With json_schema strict, this should always parse.
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
<Response>
  <Say>Sorry, this number is not configured.</Say>
</Response>`);
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

    // Persist user + assistant to DB async (don’t block)
    void storeConversation(business.id, fromNumber, "voice", "user", userSpeech, callSid);

    const assistantJson = await getAssistantJson(business.system_prompt, currentHistory, userSpeech);

    const reply = (assistantJson.reply || "").trim() || "Thanks—what suburb are you in?";
    const leadReady = Boolean(assistantJson.lead_ready);
    const lead = assistantJson.lead || {};

    // Update in-memory session history for faster next turn
    const nextHistory = [
      ...currentHistory,
      { role: "user", message: userSpeech },
      { role: "assistant", message: reply },
    ].slice(-10);
    voiceSessionHistory.set(sessionKey, nextHistory);

    void storeConversation(business.id, fromNumber, "voice", "assistant", reply, callSid);

    // Upsert voice lead (1 per callSid)
    void upsertVoiceLead(
      business.id,
      callSid,
      { ...lead, lead_ready: leadReady },
      fromNumber
    );

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

    // Store user async
    void storeConversation(business.id, fromNumber, "sms", "user", userMessage, null);

    // Persistent SMS history (keep it small)
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

    // Create a lead only once it’s ready (avoid spam)
    if (leadReady) {
      void insertSmsLead(business.id, fromNumber, lead);
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