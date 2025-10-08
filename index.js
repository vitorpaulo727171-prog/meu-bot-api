const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');

const app = express();
const PORT = process.env.PORT || 3000;

// Middlewares
app.use(cors());
app.use(express.json());

// Configuração do cliente OpenAI para GitHub
const client = new OpenAI({
  baseURL: "https://models.inference.ai.azure.com", // ou "https://models.github.ai/inference"
  apiKey: process.env.GITHUB_TOKEN
});

// Rota principal
app.get('/', (req, res) => {
  res.json({ 
    message: 'IA Professora de Cálculo - API Funcionando!',
    status: 'online',
    instrucoes: 'Envie POST para /perguntar com { "pergunta": "sua pergunta" }'
  });
});

// Rota para fazer perguntas à IA
app.post('/perguntar', async (req, res) => {
  try {
    const { pergunta } = req.body;

    if (!pergunta) {
      return res.status(400).json({ 
        error: 'Por favor, forneça uma pergunta no corpo da requisição' 
      });
    }

    console.log(`📚 Pergunta recebida: ${pergunta}`);

    const response = await client.chat.completions.create({
      messages: [
        { 
          role: "system", 
          content: `Você é uma professora de cálculo muito paciente e didática. 
          Explique conceitos matemáticos de forma clara e passo a passo.
          Use exemplos práticos e seja encorajadora.
          Se a pergunta não for sobre matemática, gentilmente redirecione para o tema.` 
        },
        { 
          role: "user", 
          content: pergunta 
        }
      ],
      temperature: 0.7,
      max_tokens: 500,
      model: "gpt-4"
    });

    const resposta = response.choices[0].message.content;

    console.log('✅ Resposta da IA gerada');

    res.json({
      pergunta: pergunta,
      resposta: resposta,
      professora: "IA Professora de Cálculo",
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Erro:', error.message);
    
    // Resposta de fallback em caso de erro
    const fallbackResponse = {
      pergunta: req.body.pergunta,
      resposta: "Olá! Sou sua professora de cálculo. No momento estou com dificuldades técnicas. Por favor, tente novamente em alguns instantes. Enquanto isso, lembre-se: a prática leva à perfeição! 📚✨",
      professora: "IA Professora de Cálculo (Modo Offline)",
      erro: error.message,
      timestamp: new Date().toISOString()
    };

    res.status(500).json(fallbackResponse);
  }
});

// Rota de teste simples
app.get('/teste', async (req, res) => {
  try {
    const response = await client.chat.completions.create({
      messages: [
        { 
          role: "system", 
          content: "Você é uma professora de cálculo. Responda de forma educada." 
        },
        { 
          role: "user", 
          content: "O que é uma derivada?" 
        }
      ],
      temperature: 0.7,
      max_tokens: 300,
      model: "gpt-4"
    });

    res.json({
      pergunta: "O que é uma derivada?",
      resposta: response.choices[0].message.content,
      status: "IA funcionando corretamente"
    });

  } catch (error) {
    res.json({
      pergunta: "O que é uma derivada?",
      resposta: "Uma derivada representa a taxa de variação instantânea de uma função. Imagine que você está dirigindo um carro - a derivada da posição em relação ao tempo é a velocidade! 🚗📈",
      status: "Modo fallback - IA offline"
    });
  }
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`🎓 IA Professora de Cálculo rodando na porta ${PORT}`);
  console.log(`📚 Endpoint: http://localhost:${PORT}/perguntar`);
  console.log(`🧪 Teste: http://localhost:${PORT}/teste`);
  console.log(`🔧 Usando GitHub Models: ${!!process.env.GITHUB_TOKEN}`);
});
