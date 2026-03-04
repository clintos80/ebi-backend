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
   HELPERS
================================= */

async function getBusinessByPhoneNumber(twilioToNumber) {
  const { data, error } = await supabase
    .from("businesses")
    .select("*")
    .eq("phone_number", twilioToNumber)
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("Business lookup error:", error.message);
    return null;
  }

  return data;
}

async function storeConversation(
  businessId,
  userPhone,
  channel,
  role,
  message,
  callSid = null
) {
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

// Voice memory: session-only (CallSid)
async function getVoiceHistory(businessId, callSid) {
  const { data, error } = await supabase
    .from("conversations")
    .select("role, message")
    .eq("business_id", businessId)
    .eq("call_sid", callSid)
    .order("created_at", { ascending: true });

  if (error) console.error("Voice history error:", error.message);

  return data || [];
}

// SMS memory: persistent (phone)
async function getSmsHistory(businessId, userPhone) {
  const { data, error } = await supabase
    .from("conversations")
    .select("role, message")
    .eq("business_id", businessId)
    .eq("user_phone", userPhone)
    .order("created_at", { ascending: true })
    .limit(15);

  if (error) console.error("SMS history error:", error.message);

  return data || [];
}

async function generateAIReply(systemPrompt, history, userInput) {
  const cleanedHistory = (history || [])
    .filter((m) => m && m.role && m.message)
    .map((m) => ({ role: m.role, content: m.message }));

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

/* ===============================
   ROUTES
================================= */

app.get("/", (req, res) => {
  res.send("Ebi SaaS backend is running");
});

// VOICE ENTRY
app.post("/voice", async (req, res) => {
  const toNumber = req.body.To;

  console.log("VOICE /voice To:", toNumber); // helpful debug

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

// VOICE PROCESS
app.post("/process", async (req, res) => {
  try {
    const toNumber = req.body.To;
    const fromNumber = req.body.From;
    const callSid = req.body.CallSid;
    const userSpeech = req.body.SpeechResult;

    console.log("VOICE /process To:", toNumber, "CallSid:", callSid);

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

    // store user
    await storeConversation(
      business.id,
      fromNumber,
      "voice",
      "user",
      userSpeech,
      callSid
    );

    // session memory (per call)
    const history = await getVoiceHistory(business.id, callSid);

    const aiReply = await generateAIReply(
      business.system_prompt,
      history,
      userSpeech
    );

    // store assistant
    await storeConversation(
      business.id,
      fromNumber,
      "voice",
      "assistant",
      aiReply,
      callSid
    );

    return res.type("text/xml").send(`
<Response>
  <Say voice="Polly.Joanna-Neural">${aiReply}</Say>
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

// SMS
app.post("/sms", async (req, res) => {
  try {
    const toNumber = req.body.To;
    const fromNumber = req.body.From;
    const userMessage = req.body.Body;

    console.log("SMS /sms To:", toNumber);

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

    await storeConversation(business.id, fromNumber, "sms", "user", userMessage);

    const history = await getSmsHistory(business.id, fromNumber);

    const aiReply = await generateAIReply(
      business.system_prompt,
      history,
      userMessage
    );

    await storeConversation(
      business.id,
      fromNumber,
      "sms",
      "assistant",
      aiReply
    );

    return res.type("text/xml").send(`
<Response>
  <Message>${aiReply}</Message>
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));