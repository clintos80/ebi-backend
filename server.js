require("dotenv").config();

const express = require("express");
const OpenAI = require("openai");
const bodyParser = require("body-parser");

const app = express();

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

app.get("/", (req, res) => {
  res.send("Ebi backend is running");
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

async function generateAIReply(userInput) {
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: `You are Ebi, an intelligent Australian AI receptionist for local service businesses.
Be concise, friendly and professional. Keep replies under 3 sentences.`,
      },
      {
        role: "user",
        content: userInput,
      },
    ],
  });

  return completion.choices[0].message.content;
}

// Voice start
app.post("/voice", (req, res) => {
  const twiml = `
<Response>
  <Say>Hello, this is Ebi, your AI receptionist. How can I help you today?</Say>
  <Gather input="speech" action="/process" method="POST" timeout="5" />
</Response>
  `;
  res.type("text/xml");
  res.send(twiml);
});

// Voice process
app.post("/process", async (req, res) => {
  try {
    const userSpeech = req.body.SpeechResult;

    let aiReply = "Sorry, I didn't catch that. Could you repeat?";

    if (userSpeech) {
      aiReply = await generateAIReply(userSpeech);
    }

    const twiml = `
<Response>
  <Say>${aiReply}</Say>
  <Gather input="speech" action="/process" method="POST" timeout="5" />
</Response>
    `;

    res.type("text/xml");
    res.send(twiml);
  } catch (error) {
    console.error("Voice error:", error.message);

    res.type("text/xml");
    res.send(`
<Response>
  <Say>Sorry, something went wrong. Please try again later.</Say>
</Response>
    `);
  }
});

// SMS
app.post("/sms", async (req, res) => {
  try {
    const userMessage = req.body.Body;

    let aiReply = "Sorry, I didn't understand that.";

    if (userMessage) {
      aiReply = await generateAIReply(userMessage);
    }

    const twiml = `
<Response>
  <Message>${aiReply}</Message>
</Response>
    `;

    res.type("text/xml");
    res.send(twiml);
  } catch (error) {
    console.error("SMS error:", error.message);

    res.type("text/xml");
    res.send(`
<Response>
  <Message>Sorry, something went wrong. Please try again later.</Message>
</Response>
    `);
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});