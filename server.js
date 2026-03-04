require("dotenv").config();
const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const OpenAI = require("openai");
const twilio = require("twilio");

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ===== Clients =====
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ===== Helper: Find Business =====
async function getBusinessByNumber(twilioNumber) {
  const { data } = await supabase
    .from("businesses")
    .select("*")
    .eq("twilio_number", twilioNumber)
    .single();

  return data;
}

// ===== Store Conversation =====
async function storeConversation(
  businessId,
  userPhone,
  channel,
  role,
  message,
  callSid = null
) {
  await supabase.from("conversations").insert([
    {
      business_id: businessId,
      user_phone: userPhone,
      channel,
      role,
      message,
      call_sid: callSid,
    },
  ]);
}

// ===== Voice History (Session-Based) =====
async function getVoiceHistory(businessId, callSid) {
  const { data } = await supabase
    .from("conversations")
    .select("role, message")
    .eq("business_id", businessId)
    .eq("call_sid", callSid)
    .order("created_at", { ascending: true });

  return data || [];
}

// ===== SMS History (Persistent) =====
async function getSMSHistory(businessId, phone) {
  const { data } = await supabase
    .from("conversations")
    .select("role, message")
    .eq("business_id", businessId)
    .eq("user_phone", phone)
    .order("created_at", { ascending: true })
    .limit(15);

  return data || [];
}

// ===== Generate AI Reply =====
async function generateAIReply(systemPrompt, history, userInput) {
  const cleanedHistory = history
    .filter((msg) => msg.role && msg.message)
    .map((msg) => ({
      role: msg.role,
      content: msg.message,
    }));

  const messages = [
    { role: "system", content: systemPrompt },
    ...cleanedHistory,
    { role: "user", content: userInput },
  ];

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages,
  });

  return completion.choices[0].message.content;
}

// ===== VOICE ENTRY =====
app.post("/voice", async (req, res) => {
  const toNumber = req.body.To;
  const business = await getBusinessByNumber(toNumber);

  if (!business) {
    return res.send(`
      <Response>
        <Say>Sorry, this number is not configured.</Say>
      </Response>
    `);
  }

  res.send(`
    <Response>
      <Gather input="speech" timeout="4" speechTimeout="auto" action="/process" method="POST">
        <Say voice="Polly.Amy-Neural">
          Hello. Thank you for calling ${business.name}. How can I help you today?
        </Say>
      </Gather>
    </Response>
  `);
});

// ===== VOICE PROCESS =====
app.post("/process", async (req, res) => {
  try {
    const fromNumber = req.body.From;
    const toNumber = req.body.To;
    const callSid = req.body.CallSid;
    const userSpeech = req.body.SpeechResult || "";

    const business = await getBusinessByNumber(toNumber);
    if (!business) {
      return res.send(`
        <Response>
          <Say>Business not found.</Say>
        </Response>
      `);
    }

    if (!userSpeech) {
      return res.send(`
        <Response>
          <Redirect>/voice</Redirect>
        </Response>
      `);
    }

    await storeConversation(
      business.id,
      fromNumber,
      "voice",
      "user",
      userSpeech,
      callSid
    );

    const history = await getVoiceHistory(business.id, callSid);

    const aiReply = await generateAIReply(
      business.system_prompt,
      history,
      userSpeech
    );

    await storeConversation(
      business.id,
      fromNumber,
      "voice",
      "assistant",
      aiReply,
      callSid
    );

    res.send(`
      <Response>
        <Gather input="speech" timeout="4" speechTimeout="auto" action="/process" method="POST">
          <Say voice="Polly.Amy-Neural">
            ${aiReply}
          </Say>
        </Gather>
      </Response>
    `);
  } catch (err) {
    console.error("Voice error:", err.message);

    res.send(`
      <Response>
        <Say>Sorry, something went wrong.</Say>
      </Response>
    `);
  }
});

// ===== SMS =====
app.post("/sms", async (req, res) => {
  try {
    const fromNumber = req.body.From;
    const toNumber = req.body.To;
    const body = req.body.Body;

    const business = await getBusinessByNumber(toNumber);
    if (!business) {
      return res.send("Number not configured.");
    }

    await storeConversation(
      business.id,
      fromNumber,
      "sms",
      "user",
      body
    );

    const history = await getSMSHistory(business.id, fromNumber);

    const aiReply = await generateAIReply(
      business.system_prompt,
      history,
      body
    );

    await storeConversation(
      business.id,
      fromNumber,
      "sms",
      "assistant",
      aiReply
    );

    res.send(`
      <Response>
        <Message>${aiReply}</Message>
      </Response>
    `);
  } catch (err) {
    console.error("SMS error:", err.message);
    res.send("Something went wrong.");
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});