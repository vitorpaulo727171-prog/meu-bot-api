const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

// Middlewares
app.use(cors());
app.use(express.json());

// Configuração da API
const GITHUB_API_CONFIG = {
  endpoint: "https://models.inference.ai.azure.com",
  apiKey: process.env.GITHUB_TOKEN,
  model: "gpt-4"
};

// Verificação detalhada do token
console.log('🔐 Verificando configuração da IA:');
console.log('   - Token presente:', !!process.env.GITHUB_TOKEN);
console.log('   - Token inicia com:', process.env.GITHUB_TOKEN ? process.env.GITHUB_TOKEN.substring(0, 10) + '...' : 'N/A');

// Sistema de mensagem para a IA
function getSystemMessage() {
  return `Você é a Ana, atendente da loja "Mercado dos Sabores". 
  
CATÁLOGO:
- Brownies: R$ 4,00 (Ferrero, Ninho, Paçoca, Doce de Leite, Pistache, Brigadeiro)
- Dindins: R$ 5,50-6,00 (Oreo, Ninho com Avelã, Ninho com Morango, Paçoca, Browninho)
- Bolos no Pote: R$ 11,00-12,00 (Ferrero, Maracujá com Chocolate, Ninho com Morango)

Seja natural e prestativa.`;
}

// Sistema de fallback SIMPLES para teste
class FallbackSystem {
  generateResponse(message) {
    const lowerMsg = message.toLowerCase();
    
    if (lowerMsg.includes('cardápio') || lowerMsg.includes('menu')) {
      return "📋 FALLBACK: Cardápio - Brownies R$ 4,00, Dindins R$ 5,50-6,00";
    } else if (lowerMsg.includes('brownie')) {
      return "🍫 FALLBACK: Brownies - Temos Ferrero, Ninho, Paçoca por R$ 4,00";
    } else {
      return "🤖 FALLBACK: Olá! Sou a Ana do Mercado dos Sabores!";
    }
  }
}

const fallbackSystem = new FallbackSystem();

// Função para testar a IA do GitHub
async function testGitHubAI() {
  if (!GITHUB_API_CONFIG.apiKey) {
    return { success: false, error: 'Token não configurado' };
  }

  try {
    console.log('🧪 Testando conexão com GitHub AI...');
    
    const testResponse = await fetch(`${GITHUB_API_CONFIG.endpoint}/openai/deployments/${GITHUB_API_CONFIG.model}/chat/completions?api-version=2023-12-01-preview`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GITHUB_API_CONFIG.apiKey}`,
        'api-key': GITHUB_API_CONFIG.apiKey
      },
      body: JSON.stringify({
        messages: [
          {
            role: "system",
            content: "Responda apenas com 'TESTE_IA_FUNCIONANDO'"
          },
          {
            role: "user",
            content: "Teste de conexão"
          }
        ],
        max_tokens: 10,
        temperature: 0.1
      }),
      timeout: 10000
    });

    if (!testResponse.ok) {
      const errorText = await testResponse.text();
      return { 
        success: false, 
        error: `Erro HTTP: ${testResponse.status}`,
        details: errorText
      };
    }

    const data = await testResponse.json();
    return { 
      success: true, 
      data: data,
      message: 'Conexão com IA estabelecida com sucesso!'
    };

  } catch (error) {
    return { 
      success: false, 
      error: error.message 
    };
  }
}

// Função principal da IA
async function getAIResponse(userMessage) {
  const testResult = await testGitHubAI();
  
  if (!testResult.success) {
    console.log('❌ IA não disponível - Usando fallback');
    console.log('   Erro:', testResult.error);
    return {
      response: fallbackSystem.generateResponse(userMessage),
      source: 'fallback',
      error: testResult.error
    };
  }

  try {
    console.log('✅ IA disponível - Processando com GitHub AI...');
    
    const response = await fetch(`${GITHUB_API_CONFIG.endpoint}/openai/deployments/${GITHUB_API_CONFIG.model}/chat/completions?api-version=2023-12-01-preview`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GITHUB_API_CONFIG.apiKey}`,
        'api-key': GITHUB_API_CONFIG.apiKey
      },
      body: JSON.stringify({
        messages: [
          {
            role: "system",
            content: getSystemMessage()
          },
          {
            role: "user",
            content: userMessage
          }
        ],
        max_tokens: 300,
        temperature: 0.7
      })
    });

    if (!response.ok) {
      throw new Error(`Erro API: ${response.status}`);
    }

    const data = await response.json();
    
    if (data.choices && data.choices[0].message) {
      return {
        response: data.choices[0].message.content,
        source: 'github-ai',
        error: null
      };
    } else {
      throw new Error('Resposta inválida da API');
    }

  } catch (error) {
    console.log('❌ Erro na IA - Usando fallback:', error.message);
    return {
      response: fallbackSystem.generateResponse(userMessage),
      source: 'fallback',
      error: error.message
    };
  }
}

// Rotas de Teste

// Rota principal
app.get('/', (req, res) => {
  res.json({ 
    message: 'API de Teste IA - Mercado dos Sabores',
    status: 'online',
    endpoints: {
      test: '/test-ai?message=sua_mensagem',
      status: '/status',
      health: '/health'
    }
  });
});

// Rota de status detalhado
app.get('/status', async (req, res) => {
  const testResult = await testGitHubAI();
  
  res.json({
    status: 'online',
    timestamp: new Date().toISOString(),
    ia_configurada: !!process.env.GITHUB_TOKEN,
    ia_funcionando: testResult.success,
    ia_erro: testResult.error,
    mensagem: testResult.success ? '✅ IA GitHub funcionando!' : '❌ IA GitHub com problemas'
  });
});

// Rota de saúde
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    service: 'Mercado dos Sabores Bot',
    ia: process.env.GITHUB_TOKEN ? 'configurada' : 'não configurada'
  });
});

// Rota de teste principal
app.get('/test-ai', async (req, res) => {
  const { message } = req.query;
  
  if (!message) {
    return res.json({ 
      error: 'Forneça o parâmetro ?message=sua_mensagem',
      exemplo: 'https://meu-bot-api-9dz3.onrender.com/test-ai?message=Qual o cardápio?'
    });
  }
  
  try {
    const startTime = Date.now();
    const result = await getAIResponse(message);
    const responseTime = Date.now() - startTime;
    
    res.json({
      mensagem_original: message,
      resposta: result.response,
      fonte: result.source,
      tempo_resposta: `${responseTime}ms`,
      ia_funcionando: result.source === 'github-ai',
      erro: result.error,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ 
      error: 'Erro interno',
      detalhes: error.message 
    });
  }
});

// Rota do webhook para AutoReply
app.post('/webhook', async (req, res) => {
  console.log('📩 Mensagem recebida:', req.body);
  
  const { senderMessage, senderName, isMessageFromGroup } = req.body;
  
  if (isMessageFromGroup) {
    return res.json({ data: [{ message: "" }] });
  }
  
  try {
    const result = await getAIResponse(senderMessage);
    
    console.log(`💬 Resposta para ${senderName}:`);
    console.log(`   Fonte: ${result.source}`);
    console.log(`   IA funcionando: ${result.source === 'github-ai'}`);
    if (result.error) console.log(`   Erro: ${result.error}`);
    
    res.json({
      data: [{ message: result.response }]
    });
  } catch (error) {
    console.error('❌ Erro no webhook:', error);
    const fallback = fallbackSystem.generateResponse(senderMessage);
    res.json({ 
      data: [{ message: fallback }]
    });
  }
});

// Iniciar servidor com teste automático
app.listen(PORT, async () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  console.log(`🔗 URL: https://meu-bot-api-9dz3.onrender.com`);
  console.log(`🧪 Iniciando teste automático da IA...`);
  
  // Teste automático ao iniciar
  const testResult = await testGitHubAI();
  if (testResult.success) {
    console.log('✅ IA GitHub: FUNCIONANDO PERFEITAMENTE!');
  } else {
    console.log('❌ IA GitHub: FALHOU -', testResult.error);
    console.log('📝 Usando sistema de fallback');
  }
  
  console.log(`📞 Webhook pronto: https://meu-bot-api-9dz3.onrender.com/webhook`);
  console.log(`🔍 Teste: https://meu-bot-api-9dz3.onrender.com/test-ai?message=Oi`);
});
