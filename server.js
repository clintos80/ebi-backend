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
const businessCache = new Map(); // key: toNumber -> { business, expiresAt }

/* ===============================
   LATENCY TRICK 2: In-memory session history
================================= */
const voiceSessionHistory = new Map(); // callSid -> [{role, message}, ...]
const VOICE_SESSION_TTL_MS = 20 * 60 * 1000; // 20 mins
const voiceSessionExpiry = new Map(); // callSid -> expiresAt

function touchVoiceSession(callSid) {
  voiceSessionExpiry.set(callSid, Date.now() + VOICE_SESSION_TTL_MS);
}

function cleanupExpiredSessions() {
  const now = Date.now();
  for (const [callSid, exp] of voiceSessionExpiry.entries()) {
    if (exp <= now) {
      voiceSessionExpiry.delete(callSid);
      voiceSessionHistory.delete(callSid);
    }
  }
}
setInterval(cleanupExpiredSessions, 60 * 1000).unref();

/* ===============================
   Helpers
================================= */

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
    businessCache.set(toNumber, { business: data, expiresAt: Date.now() + BUSINESS_CACHE_TTL_MS });
  }

  return data;
}

async function storeConversation(businessId, userPhone, channel, role, message, callSid = null) {
  const { error } = await supabase.from("conversations").insert([
    { business_id: businessId, user_phone: userPhone, channel, role, message, call_sid: callSid },
  ]);
  if (error) console.error("Store conversation error:", error.message);
}

/**
 * Upsert a lead for voice calls by (business_id, call_sid).
 * For SMS, we create a new lead only when model says lead_ready=true (below).
 */
async function upsertVoiceLead(businessId, callSid, lead) {
  if (!callSid) return;

  const payload = {
    business_id: businessId,
    source: "voice",
    call_sid: callSid,
    customer_phone: lead.customer_phone || null,
    customer_name: lead.customer_name || null,
    suburb: lead.suburb || null,
    address: lead.address || null,
    job_type: lead.job_type || null,
    urgency: lead.urgency || null,
    preferred_time: lead.preferred_time || null,
    notes: lead.notes || null,
    status: lead.status || "new",
  };

  const { error } = await supabase
    .from("leads")
    .upsert(payload, { onConflict: "business_id,call_sid" });

  if (error) console.error("Lead upsert error:", error.message);
}

async function insertSmsLead(businessId, fromNumber, lead) {
  const payload = {
    business_id: businessId,
    source: "sms",
    call_sid: null,
    customer_phone: lead.customer_phone || fromNumber || null,
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

/**
 * One-call approach: model returns JSON with:
 * { reply: string, lead_ready: boolean, lead: { ...fields... } }
 */
async function getAssistantJson(systemPrompt, history, userInput) {
  const cleanedHistory = (history || [])
    .filter((m) => m && m.role && m.message)
    .map((m) => ({ role: m.role, content: m.message }));

  const messages = [
    {
      role: "system",
      content: `${systemPrompt}

You must help the caller like a receptionist AND extract lead info.

Return ONLY valid JSON in this exact shape:
{
  "reply": "string",
  "lead_ready": boolean,
  "lead": {
    "customer_name": "string|null",
    "customer_phone": "string|null",
    "suburb": "string|null",
    "address": "string|null",
    "job_type": "string|null",
    "urgency": "emergency|today|this_week|quote|unknown|null",
    "preferred_time": "string|null",
    "notes": "string|null",
    "status": "new|in_progress|booked|closed|null"
  }
}

Rules:
- "reply" must sound natural and human.
- Keep reply under 2 short sentences.
- Ask ONLY for missing fields that matter next.
- Set lead_ready=true only when you have: name, job_type, urgency, preferred_time, and at least suburb OR address.
- If caller’s phone is known from the system, you may set customer_phone=null (we’ll store it ourselves).
- Output JSON only. No markdown.`,
    },
    ...cleanedHistory,
    { role: "user", content: userInput },
  ];

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages,
  });

  const raw = completion.choices?.[0]?.message?.content || "";
  try {
    return JSON.parse(raw);
  } catch (e) {
    // Fallback: don’t break calls if model outputs non-JSON
    console.error("JSON parse failed. Raw model output:", raw);
    return {
      reply: "Thanks—could you share your name, suburb, and what electrical issue you’re having?",
      lead_ready: false,
      lead: {
        customer_name: null,
        customer_phone: null,
        suburb: null,
        address: null,
        job_type: null,
        urgency: "unknown",
        preferred_time: null,
        notes: null,
        status: "in_progress",
      },
    };
  }
}

/* ===============================
   Routes
================================= */

app.get("/", (req, res) => {
  res.send("Ebi SaaS backend is running");
});

/* ========= VOICE ENTRY ========= */

app.post("/voice", async (req, res) => {
  const toNumber = req.body.To;
  const business = await getBusinessByPhoneNumber(toNumber);

  if (!business) {
    return res.type("text/xml").send(`
<Response>
  <Say>Sorry, this number is not configured.</Say>
</Response>
    `);
  }

  return res.type("text/xml").send(`
<Response>
  <Say voice="Polly.Joanna-Neural">
    Hello, thank you for calling ${business.business_name}. How can I help you today?
  </Say>
  <Gather input="speech" action="/process" method="POST" timeout="5" speechTimeout="auto" />
</Response>
  `);
});

/* ========= VOICE PROCESS ========= */

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
</Response>
      `);
    }

    if (!userSpeech) {
      return res.type("text/xml").send(`
<Response>
  <Say voice="Polly.Joanna-Neural">Sorry, I didn’t catch that. Could you repeat?</Say>
  <Gather input="speech" action="/process" method="POST" timeout="5" speechTimeout="auto" />
</Response>
      `);
    }

    // Session history (in-memory, per call)
    const sessionKey = callSid || "no-callSid";
    const currentHistory = voiceSessionHistory.get(sessionKey) || [];
    touchVoiceSession(sessionKey);

    // Store user message asynchronously (don’t block response)
    void storeConversation(business.id, fromNumber, "voice", "user", userSpeech, callSid).catch(console.error);

    // Ask model for JSON response (reply + lead)
    const assistantJson = await getAssistantJson(business.system_prompt, currentHistory, userSpeech);

    const reply = (assistantJson?.reply || "").toString().trim() || "Thanks—can you share a bit more detail?";
    const lead = assistantJson?.lead || {};
    const leadReady = Boolean(assistantJson?.lead_ready);

    // Update in-memory session history (so next turn is fast)
    const nextHistory = [
      ...currentHistory,
      { role: "user", message: userSpeech },
      { role: "assistant", message: reply },
    ].slice(-10);
    voiceSessionHistory.set(sessionKey, nextHistory);

    // Store assistant message asynchronously
    void storeConversation(business.id, fromNumber, "voice", "assistant", reply, callSid).catch(console.error);

    // Upsert lead per callSid (so you get 1 lead record per call, updated as info arrives)
    const leadForDb = {
      ...lead,
      customer_phone: fromNumber || lead.customer_phone || null,
      status: leadReady ? (lead.status || "new") : "in_progress",
    };
    void upsertVoiceLead(business.id, callSid, leadForDb).catch(console.error);

    return res.type("text/xml").send(`
<Response>
  <Say voice="Polly.Joanna-Neural">${escapeXml(reply)}</Say>
  <Gather input="speech" action="/process" method="POST" timeout="5" speechTimeout="auto" />
</Response>
    `);
  } catch (err) {
    console.error("Voice error:", err.message);
    return res.type("text/xml").send(`
<Response>
  <Say>Sorry, something went wrong.</Say>
</Response>
    `);
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
</Response>
      `);
    }

    if (!userMessage) {
      return res.type("text/xml").send(`
<Response>
  <Message>Sorry, I didn’t catch that.</Message>
</Response>
      `);
    }

    // Persist messages (async to reduce perceived delay)
    void storeConversation(business.id, fromNumber, "sms", "user", userMessage, null).catch(console.error);

    // For SMS, keep persistent memory by pulling last 12 messages (can cache later)
    const { data: smsHistory } = await supabase
      .from("conversations")
      .select("role, message")
      .eq("business_id", business.id)
      .eq("user_phone", fromNumber)
      .order("created_at", { ascending: true })
      .limit(12);

    const assistantJson = await getAssistantJson(business.system_prompt, smsHistory || [], userMessage);

    const reply = (assistantJson?.reply || "").toString().trim() || "Thanks—can you share your suburb and what issue you’re having?";
    const lead = assistantJson?.lead || {};
    const leadReady = Boolean(assistantJson?.lead_ready);

    void storeConversation(business.id, fromNumber, "sms", "assistant", reply, null).catch(console.error);

    // For SMS: only create a lead when it’s ready (to avoid spamming rows)
    if (leadReady) {
      const leadForDb = {
        ...lead,
        customer_phone: fromNumber || lead.customer_phone || null,
        status: lead.status || "new",
      };
      void insertSmsLead(business.id, fromNumber, leadForDb).catch(console.error);
    }

    return res.type("text/xml").send(`
<Response>
  <Message>${escapeXml(reply)}</Message>
</Response>
    `);
  } catch (err) {
    console.error("SMS error:", err.message);
    return res.type("text/xml").send(`
<Response>
  <Message>Sorry, something went wrong.</Message>
</Response>
    `);
  }
});

/* ===============================
   Utility: escape TwiML XML
================================= */
function escapeXml(unsafe) {
  return String(unsafe)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));