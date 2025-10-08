const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

// Middlewares
app.use(cors());
app.use(express.json());

// Configuração SEGURA - apenas variável de ambiente
const GITHUB_API_CONFIG = {
  endpoint: "https://models.inference.ai.azure.com",
  apiKey: process.env.GITHUB_TOKEN, // ⚠️ APENAS VARIÁVEL DE AMBIENTE
  model: "gpt-4"
};

// Verificação de segurança
if (!process.env.GITHUB_TOKEN) {
  console.warn('⚠️  GITHUB_TOKEN não configurado - usando apenas fallback');
}

// ... (o resto do código permanece igual ao anterior)
function getSystemMessage() {
  return `Você é um atendente virtual da loja "Mercado dos Sabores". Seja simpático, prestativo e sempre informe preços e disponibilidade.

CATÁLOGO DA LOJA:

🍫 BROWNIES (R$ 4,00 cada):
• Brownie Ferrero ✅
• Brownie Beijinho ❌ (INDISPONÍVEL)
• Brownie Doce de Leite ✅
• Brownie Ninho ✅
• Brownie Paçoca ✅
• Brownie Pistache ✅
• Brownie de Brigadeiro ✅

🍨 DINDINS GOURMET:
• Dindin Oreo - R$ 5,50 ✅
• Dindin Ninho com Avelã - R$ 6,00 ✅
• Dindin Ninho com Geleia de Morango - R$ 6,00 ✅
• Dindin Paçoca - R$ 5,50 ✅
• Dindin Browninho - R$ 5,50 ✅

🎂 BOLOS NO POTE:
• Bolo de Pote Ferrero - R$ 12,00 ✅
• Bolo de Pote Maracujá com Chocolate - R$ 12,00 ✅
• Bolo de Pote Ninho com Geleia de Morango - R$ 11,00 ✅

🍰 SOBREMESAS:
• Delícia de Abacaxi - R$ 5,50 ✅
• Pavê KitKat - R$ 6,50 ✅
• Sensação - R$ 6,50 ✅
• Torta Cookie - R$ 6,50 ✅
• Torta de Limão - R$ 5,00 ✅

📍 INFORMAÇÕES IMPORTANTES:
• Endereço: Rua Raimundo Lemos Dias, 68
• Pagamento: PIX e Dinheiro
• Site: https://lojams.rf.gd

Orientações: Seja claro sobre preços e disponibilidade. Para produtos indisponíveis, sugira alternativas. Mantenha respostas úteis e diretas.`;
}

// Sistema de fallback (mantido igual)
class FallbackSystem {
  generateResponse(message) {
    const lowerMsg = message.toLowerCase();
    
    if (lowerMsg.includes('oi') || lowerMsg.includes('olá')) {
      return "Olá! Bem-vindo ao Mercado dos Sabores! 🎉\nComo posso ajudar você hoje?";
    } else if (lowerMsg.includes('cardápio') || lowerMsg.includes('menu')) {
      return this.getMenu();
    } else if (lowerMsg.includes('preço') || lowerMsg.includes('quanto')) {
      return this.getPriceInfo(lowerMsg);
    } else if (lowerMsg.includes('endereço') || lowerMsg.includes('onde')) {
      return "📍 *Endereço de Retirada:* Rua Raimundo Lemos Dias, 68\n\nVocê pode retirar seu pedido aqui!";
    } else if (lowerMsg.includes('pagamento') || lowerMsg.includes('pix')) {
      return "💳 *Formas de Pagamento:*\n• PIX\n• Dinheiro\n\nAceitamos estas duas formas de pagamento!";
    } else if (lowerMsg.includes('site') || lowerMsg.includes('online')) {
      return "🌐 *Site para Encomendas:*\nhttps://lojams.rf.gd\n\nNo site você encontra fotos e pode fazer pedidos online!";
    } else {
      return this.getProductResponse(lowerMsg);
    }
  }

  getMenu() {
    return `📋 *CARDÁPIO MERCADO DOS SABORES*

🍫 BROWNIES (R$ 4,00):
• Ferrero, Doce de Leite, Ninho, Paçoca, Pistache, Brigadeiro

🍨 DINDINS (R$ 5,50-6,00):
• Oreo, Ninho com Avelã, Ninho com Morango, Paçoca, Browninho

🎂 BOLOS NO POTE (R$ 11,00-12,00):
• Ferrero, Maracujá com Chocolate, Ninho com Morango

🍰 SOBREMESAS (R$ 5,00-6,50):
• Delícia de Abacaxi, Pavê KitKat, Sensação, Torta Cookie, Torta de Limão

💻 *Site completo:* https://lojams.rf.gd`;
  }

  getPriceInfo(message) {
    if (message.includes('brownie')) {
      return "🍫 *Brownies:* R$ 4,00 cada\nTemos: Ferrero, Doce de Leite, Ninho, Paçoca, Pistache e Brigadeiro!";
    } else if (message.includes('dindin')) {
      return "🍨 *Dindins:* R$ 5,50 a R$ 6,00\nOreo: R$ 5,50 | Ninho com Avelã/Morango: R$ 6,00 | Paçoca/Browninho: R$ 5,50";
    } else if (message.includes('bolo') || message.includes('pote')) {
      return "🎂 *Bolos no Pote:* R$ 11,00 a R$ 12,00\nNinho com Morango: R$ 11,00 | Ferrero/Maracujá: R$ 12,00";
    } else {
      return "💰 *Nossos Preços:*\n• Brownies: R$ 4,00\n• Dindins: R$ 5,50-6,00\n• Bolos no Pote: R$ 11,00-12,00\n• Sobremesas: R$ 5,00-6,50\n\nPergunte sobre um produto específico!";
    }
  }

  getProductResponse(message) {
    const products = {
      'ferrero': "🍫 *Brownie Ferrero:* R$ 4,00 - Brownie intenso com recheio de brigadeiro 50% cacau (DISPONÍVEL)",
      'ninho': "🍫 *Brownie Ninho:* R$ 4,00 - Brownie molhadinho com recheio cremoso de leite Ninho (DISPONÍVEL)",
      'paçoca': "🍫 *Brownie Paçoca:* R$ 4,00 - Brownie molhadinho com recheio cremoso de paçoca (DISPONÍVEL)",
      'oreo': "🍨 *Dindin Oreo:* R$ 5,50 - Delicioso dindin sabor Oreo (DISPONÍVEL)",
      'avelã': "🍨 *Dindin Ninho com Avelã:* R$ 6,00 - Combinação incrível de ninho com avelã (DISPONÍVEL)",
      'maracujá': "🎂 *Bolo de Pote Maracujá com Chocolate:* R$ 12,00 - Sabor refrescante de maracujá (DISPONÍVEL)"
    };

    for (const [product, response] of Object.entries(products)) {
      if (message.includes(product)) {
        return response + "\n\n🌐 *Site:* https://lojams.rf.gd";
      }
    }

    return "Olá! Sou da Loja Mercado dos Sabores 🍫\nPosso ajudar com:\n• Cardápio completo\n• Preços\n• Endereço\n• Formas de pagamento\n\nO que você gostaria de saber?";
  }
}

const fallbackSystem = new FallbackSystem();

// Função para obter resposta da IA do GitHub
async function getGitHubAIResponse(userMessage) {
  // Verifica se o token está configurado via variável de ambiente
  if (!GITHUB_API_CONFIG.apiKey) {
    console.log("⚠️ Usando fallback - GITHUB_TOKEN não configurado");
    return fallbackSystem.generateResponse(userMessage);
  }

  try {
    console.log("🔄 Chamando GitHub AI...");
    
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
        max_tokens: 500,
        temperature: 0.7,
        top_p: 0.95
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`GitHub API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    
    if (data.choices && data.choices[0].message) {
      console.log("✅ Resposta da IA recebida");
      return data.choices[0].message.content;
    } else {
      throw new Error('Resposta inválida da API');
    }

  } catch (error) {
    console.error('❌ Erro GitHub AI:', error.message);
    return fallbackSystem.generateResponse(userMessage);
  }
}

// Rota principal
app.get('/', (req, res) => {
  const tokenStatus = process.env.GITHUB_TOKEN ? 'Configurado ✅' : 'Não configurado ⚠️';
  
  res.json({ 
    message: 'API do Mercado dos Sabores funcionando!',
    status: 'online',
    mode: 'GitHub AI + Fallback Inteligente',
    token_status: tokenStatus,
    security: 'API Key protegida por variável de ambiente'
  });
});

// Rota do webhook principal para AutoReply
app.post('/webhook', async (req, res) => {
  console.log('📩 Mensagem recebida:', req.body);
  
  const { senderMessage, senderName, isMessageFromGroup } = req.body;
  
  // Não responder em grupos
  if (isMessageFromGroup) {
    return res.json({ data: [{ message: "" }] });
  }
  
  try {
    const resposta = await getGitHubAIResponse(senderMessage);
    console.log(`💬 Resposta para ${senderName}: ${resposta.substring(0, 100)}...`);
    
    res.json({
      data: [{ message: resposta }]
    });
  } catch (error) {
    console.error('Erro no webhook:', error);
    const fallback = fallbackSystem.generateResponse(senderMessage);
    res.json({ data: [{ message: fallback }] });
  }
});

// Rota de status (sem informações sensíveis)
app.get('/status', (req, res) => {
  res.json({
    status: 'online',
    service: 'Mercado dos Sabores Bot',
    ai_configured: !!process.env.GITHUB_TOKEN,
    fallback_system: 'active',
    security: 'environment_variables',
    timestamp: new Date().toISOString()
  });
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  console.log(`🔗 Webhook: http://localhost:${PORT}/webhook`);
  console.log(`🤖 GitHub AI: ${process.env.GITHUB_TOKEN ? 'CONFIGURADO ✅' : 'NÃO CONFIGURADO ⚠️'}`);
  console.log(`🛡️  Fallback: ATIVO`);
  console.log(`🔒 Segurança: Variáveis de ambiente`);
});
