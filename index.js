const express = require('express');
const OpenAI = require('openai');

const app = express();
app.use(express.json());

// Configurações da API - token via variável de ambiente
const token = process.env.GITHUB_TOKEN;
const endpoint = "https://models.github.ai/inference";
const model = "openai/gpt-4.1";

// Verifica se o token está disponível
if (!token) {
  console.error("ERRO: GITHUB_TOKEN não encontrado nas variáveis de ambiente");
  process.exit(1);
}

const client = new OpenAI({
  baseURL: endpoint,
  apiKey: token
});

app.post('/webhook', async (req, res) => {
  try {
    const {
      senderMessage,
      senderName,
      groupName,
      isMessageFromGroup
    } = req.body;

    console.log(`Mensagem recebida de ${senderName}${groupName ? ` no grupo ${groupName}` : ''}: ${senderMessage}`);

    // Processa a mensagem com a IA
    const response = await client.chat.completions.create({
      messages: [
        {
          role: "system",
          content: "Você é um assistente útil e amigável. Responda de forma natural, concisa e em português."
        },
        {
          role: "user", 
          content: senderMessage
        }
      ],
      temperature: 1.0,
      top_p: 1.0,
      model: model
    });

    const aiResponse = response.choices[0].message.content;

    // Retorna a resposta no formato esperado pelo AutoReply
    res.json({
      data: [{
        message: aiResponse
      }]
    });

  } catch (error) {
    console.error('Erro ao processar mensagem:', error);
    
    // Resposta de fallback em caso de erro
    res.json({
      data: [{
        message: "Desculpe, estou tendo problemas para processar sua mensagem no momento. Poderia tentar novamente?"
      }]
    });
  }
});

// ... código anterior mantido ...

// Rota específica para uptime monitoring (resposta mínima)
app.get('/ping', (req, res) => {
  res.status(200).send('OK');
});

// Rota de health check melhorada
app.get('/health', async (req, res) => {
  try {
    let dbStatus = 'unknown';
    try {
      await pool.execute('SELECT 1');
      dbStatus = 'connected';
    } catch (error) {
      dbStatus = 'disconnected';
    }

    res.status(200).json({ 
      status: 'OK', 
      database: dbStatus,
      timestamp: new Date().toISOString(),
      uptime: process.uptime()
    });
  } catch (error) {
    res.status(500).json({ 
      status: 'Error', 
      message: 'Service unhealthy',
      error: error.message 
    });
  }
});

// Rota raiz com informações
app.get('/', (req, res) => {
  res.json({ 
    service: 'AutoReply Webhook',
    status: 'Online',
    usage: 'POST /webhook com payload do AutoReply'
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  console.log(`📝 Webhook URL: http://localhost:${PORT}/webhook`);
});
