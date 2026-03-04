require("dotenv").config();

const express = require("express");
const OpenAI = require("openai");
const bodyParser = require("body-parser");
const { createClient } = require("@supabase/supabase-js");

const app = express();

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

/* ===============================
   SUPABASE SETUP
================================= */

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

/* ===============================
   OPENAI SETUP
================================= */

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/* ===============================
   DATABASE HELPERS
================================= */

async function getBusinessByPhone(phoneNumber) {
  const { data, error } = await supabase
    .from("businesses")
    .select("*")
    .eq("phone_number", phoneNumber)
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
  message
) {
  await supabase.from("conversations").insert([
    {
      business_id: businessId,
      user_phone: userPhone,
      channel,
      role,
      message,
    },
  ]);
}

async function getConversationHistory(businessId, userPhone) {
  const { data } = await supabase
    .from("conversations")
    .select("role, message")
    .eq("business_id", businessId)
    .eq("user_phone", userPhone)
    .order("created_at", { ascending: true })
    .limit(10);

  return data || [];
}

/* ===============================
   AI GENERATION
================================= */

async function generateAIReply(systemPrompt, history, userInput) {
  const messages = [
    { role: "system", content: systemPrompt },
    ...history.map((msg) => ({
      role: msg.role,
      content: msg.message,
    })),
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

/* ========= VOICE START ========= */

app.post("/voice", async (req, res) => {
  const toNumber = req.body.To;
  const business = await getBusinessByPhone(toNumber);

  if (!business) {
    return res.type("text/xml").send(`
<Response>
  <Say>This number is not configured.</Say>
</Response>
    `);
  }

  const twiml = `
<Response>
  <Say voice="Polly.Joanna-Neural">
    Hello, thank you for calling ${business.business_name}.
    How can I help you today?
  </Say>
  <Gather input="speech" action="/process" method="POST" timeout="5" />
</Response>
  `;

  res.type("text/xml").send(twiml);
});

/* ========= VOICE PROCESS ========= */

app.post("/process", async (req, res) => {
  try {
    const userSpeech = req.body.SpeechResult;
    const toNumber = req.body.To;
    const fromNumber = req.body.From;

    const business = await getBusinessByPhone(toNumber);

    if (!business) {
      return res.type("text/xml").send(`
<Response>
  <Say>This number is not configured.</Say>
</Response>
      `);
    }

    let aiReply = "Sorry, I didn't catch that.";

    if (userSpeech) {

      // Immediately respond to avoid silence
      const holdMessage = `
<Response>
  <Say voice="Polly.Joanna-Neural">
    Please hold while I check that for you.
  </Say>
  <Pause length="1"/>
</Response>
      `;

      res.type("text/xml").send(holdMessage);

      // Now continue AI processing in background
      const history = await getConversationHistory(
        business.id,
        fromNumber
      );

      aiReply = await generateAIReply(
        business.system_prompt,
        history,
        userSpeech
      );

      await storeConversation(
        business.id,
        fromNumber,
        "voice",
        "user",
        userSpeech
      );

      await storeConversation(
        business.id,
        fromNumber,
        "voice",
        "assistant",
        aiReply
      );

      return;
    }

  } catch (error) {
    console.error("Voice error:", error.message);
  }
});

/* ========= SMS ========= */

app.post("/sms", async (req, res) => {
  try {
    const userMessage = req.body.Body;
    const toNumber = req.body.To;
    const fromNumber = req.body.From;

    const business = await getBusinessByPhone(toNumber);

    if (!business) {
      return res.type("text/xml").send(`
<Response>
  <Message>This number is not configured.</Message>
</Response>
      `);
    }

    let aiReply = "Sorry, I didn't understand that.";

    if (userMessage) {
      const history = await getConversationHistory(
        business.id,
        fromNumber
      );

      aiReply = await generateAIReply(
        business.system_prompt,
        history,
        userMessage
      );

      await storeConversation(
        business.id,
        fromNumber,
        "sms",
        "user",
        userMessage
      );

      await storeConversation(
        business.id,
        fromNumber,
        "sms",
        "assistant",
        aiReply
      );
    }

    const twiml = `
<Response>
  <Message>${aiReply}</Message>
</Response>
    `;

    res.type("text/xml").send(twiml);

  } catch (error) {
    console.error("SMS error:", error.message);

    res.type("text/xml").send(`
<Response>
  <Message>Sorry, something went wrong.</Message>
</Response>
    `);
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});