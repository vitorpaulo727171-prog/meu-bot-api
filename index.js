const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

// Middlewares
app.use(cors());
app.use(express.json());

// Configuração da API do GitHub
const GITHUB_API_CONFIG = {
  endpoint: "https://models.inference.ai.azure.com",
  apiKey: "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",
  model: "gpt-4o-mini"
};

// Mensagem do sistema com informações da loja
function getSystemMessage() {
  return `Você é um assistente virtual da Loja 'Mercado dos Sabores'. Seja prestativo, educado e claro nas respostas.

CATÁLOGO COMPLETO DE PRODUTOS:

BROWNIES (R$ 4,00 cada):
• Brownie Ferrero - Brownie intenso com recheio de brigadeiro 50% cacau
• Brownie Beijinho - Brownie macio com recheio cremoso de coco (INDISPONÍVEL)
• Brownie Doce de Leite - Brownie macio com recheio cremoso de doce de leite
• Brownie Ninho - Brownie molhadinho com recheio cremoso de leite Ninho
• Brownie Paçoca - Brownie molhadinho com recheio cremoso de paçoca
• Brownie Pistache - Brownie com casquinha crocante, interior molhadinho
• Brownie de Brigadeiro - Brownie com casquinha crocante, interior molhadinho

DINDINS GOURMET:
• Dindin Oreo - R$ 5,50
• Dindin Ninho com Avelã - R$ 6,00
• Dindin Ninho com Geleia de Morango - R$ 6,00
• Dindin Paçoca - R$ 5,50
• Dindin Browninho - R$ 5,50

BOLOS NO POTE:
• Bolo de Pote Cenoura com Chocolate - R$ 10,00 (INDISPONÍVEL)
• Bolo de Pote Coco com Abacaxi - R$ 10,50 (INDISPONÍVEL)
• Bolo de Pote Ferrero - R$ 12,00
• Bolo de Pote Maracujá com Chocolate - R$ 12,00
• Bolo de Pote Ninho com Geleia de Morango - R$ 11,00
• Bolo de Pote Prestígio - R$ 10,00 (INDISPONÍVEL)

BOLOS INTEIROS (SOB ENCOMENDA):
• Bolo de Chocolate (500g) - R$ 27,00
• Bolo Indiano - R$ 6,00 (INDISPONÍVEL)

SOBREMESAS:
• Delícia de Abacaxi - R$ 5,50
• Pavê KitKat - R$ 6,50
• Pudim - R$ 3,50 (INDISPONÍVEL)
• Sensação - R$ 6,50
• Torta Cookie - R$ 6,50
• Torta de Limão - R$ 5,00

EMPADAS:
• Empada Camarão - R$ 6,00
• Empada Carne do Sol - R$ 5,50 (INDISPONÍVEL)
• Empada Frango - R$ 4,00

SALGADOS:
• Coxinha - R$ 5,00
• Salgado Frito Carne com Queijo - R$ 5,50
• Salgado Frito Misto - R$ 4,70
• Salgado Salsicha - R$ 4,00

KITS PARA FESTAS (SOB ENCOMENDA):
• Kit 100 Docinhos - R$ 120,00 (25% OFF)
• Kit 50 Docinhos - R$ 60,00 (25% OFF)
• Kit 100 Salgados - R$ 65,00
• Kit 50 Salgados - R$ 32,50
• Kit 100 Mini Brownies - R$ 160,00 (25% OFF)
• Kit 50 Mini Brownies - R$ 80,00 (25% OFF)

INFORMAÇÕES IMPORTANTES:
• Formas de Pagamento: PIX e Dinheiro
• Endereço de Retirada: Rua Raimundo Lemos Dias, 68
• Site para Encomendas: https://lojams.rf.gd (com informações completas e fotos)
• Produtos marcados como INDISPONÍVEL estão sem estoque no momento

Orientação: Sempre informe o preço e disponibilidade quando mencionar produtos. Para itens sem estoque, sugira alternativas similares. Direcione o cliente ao site para ver fotos e fazer pedidos. Mantenha as respostas claras e objetivas.`;
}

// Função para obter resposta da IA
async function getAIResponse(userMessage) {
  try {
    const response = await fetch(`${GITHUB_API_CONFIG.endpoint}/openai/deployments/${GITHUB_API_CONFIG.model}/chat/completions?api-version=2024-02-01`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GITHUB_API_CONFIG.apiKey}`
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
        top_p: 0.95,
        frequency_penalty: 0,
        presence_penalty: 0,
        stop: null,
        stream: false
      })
    });

    if (!response.ok) {
      throw new Error(`Erro na API: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    
    if (data.choices && data.choices.length > 0) {
      return data.choices[0].message.content;
    } else {
      throw new Error('Resposta vazia da API');
    }
  } catch (error) {
    console.error('Erro ao chamar API do GitHub:', error);
    
    // Respostas de fallback para erros
    const fallbackResponses = {
      'oi': 'Olá! Bem-vindo ao Mercado dos Sabores! 🎉 Como posso ajudar você hoje?',
      'cardápio': 'Confira nosso cardápio completo no site: https://lojams.rf.gd 📱',
      'preço': 'Temos preços acessíveis! Brownies a R$ 4,00 e Dindins a partir de R$ 5,50. 😊',
      'default': 'Olá! No momento estou com instabilidade técnica. Por favor, visite nosso site: https://lojams.rf.gd ou entre em contato diretamente. Obrigada! 🙏'
    };

    const lowerMessage = userMessage.toLowerCase();
    if (lowerMessage.includes('oi') || lowerMessage.includes('olá')) {
      return fallbackResponses.oi;
    } else if (lowerMessage.includes('cardápio') || lowerMessage.includes('menu')) {
      return fallbackResponses.cardápio;
    } else if (lowerMessage.includes('preço') || lowerMessage.includes('quanto')) {
      return fallbackResponses.preço;
    } else {
      return fallbackResponses.default;
    }
  }
}

// Rota principal
app.get('/', (req, res) => {
  res.json({ 
    message: 'API do Mercado dos Sabores funcionando!',
    status: 'online',
    features: 'IA integrada com GitHub Models'
  });
});

// Rota de saúde da API
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    timestamp: new Date().toISOString(),
    service: 'Mercado dos Sabores Bot API'
  });
});

// Rota do webhook (POST) - Principal para o AutoReply
app.post('/webhook', async (req, res) => {
  console.log('Mensagem recebida:', req.body);
  
  const { senderMessage, senderName, isMessageFromGroup, groupName } = req.body;
  
  // Evitar responder em grupos se não quiser
  if (isMessageFromGroup) {
    return res.json({
      data: [{ message: "" }] // Resposta vazia para grupos
    });
  }
  
  try {
    // Obter resposta da IA
    const resposta = await getAIResponse(senderMessage);
    
    console.log(`Resposta para ${senderName}: ${resposta}`);
    
    const response = {
      data: [{ message: resposta }]
    };
    
    res.json(response);
  } catch (error) {
    console.error('Erro no webhook:', error);
    
    // Resposta de erro genérica
    const errorResponse = {
      data: [{ 
        message: "Olá! No momento estou com dificuldades técnicas. Por favor, visite nosso site: https://lojams.rf.gd ou tente novamente em alguns instantes. Obrigada! 😊" 
      }]
    };
    
    res.json(errorResponse);
  }
});

// Rota de teste da IA
app.post('/test-ai', async (req, res) => {
  const { message } = req.body;
  
  if (!message) {
    return res.status(400).json({ error: 'Message is required' });
  }
  
  try {
    const aiResponse = await getAIResponse(message);
    res.json({
      original_message: message,
      ai_response: aiResponse,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ 
      error: 'Erro ao processar mensagem',
      details: error.message 
    });
  }
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`🚀 Servidor do Mercado dos Sabores rodando na porta ${PORT}`);
  console.log(`📞 Webhook disponível em: http://localhost:${PORT}/webhook`);
  console.log(`🤖 IA integrada com GitHub Models`);
});
