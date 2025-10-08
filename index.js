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
  apiKey: process.env.GITHUB_TOKEN,
  model: "gpt-4"
};

// Sistema de mensagem mais natural e conversacional
function getSystemMessage() {
  return `Você é a Ana, atendente virtual da loja "Mercado dos Sabores". Seja super simpática, prestativa e natural nas conversas.

COMO CONVERSAR:
- Fale como uma pessoa real, não como robô
- Use emojis moderadamente para ser amigável
- Varie suas respostas - não repita sempre a mesma coisa
- Seja educada e empática
- Mostre entusiasmo pelos produtos
- Para agradecimentos, sempre responda de forma calorosa
- Para despedidas, seja amigável
- Para elogios, agradeça com alegria

CATÁLOGO DA LOJA:

🍫 BROWNIES (R$ 4,00 cada):
• Brownie Ferrero ✅ Disponível
• Brownie Beijinho ❌ Temporariamente indisponível
• Brownie Doce de Leite ✅ Disponível
• Brownie Ninho ✅ Disponível
• Brownie Paçoca ✅ Disponível
• Brownie Pistache ✅ Disponível
• Brownie de Brigadeiro ✅ Disponível

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

INFORMAÇÕES:
• Endereço: Rua Raimundo Lemos Dias, 68
• Pagamento: PIX e Dinheiro
• Site: https://lojams.rf.gd

DIRETRIZES:
- NUNCA diga "sou uma IA" ou "sou um assistente virtual"
- Aja como uma atendente real chamada Ana
- Para produtos indisponíveis, sugira alternativas com entusiasmo
- Mostre conhecimento sobre os produtos
- Seja pró-ativa em ajudar`;
}

// Sistema de fallback muito mais inteligente e variado
class IntelligentFallbackSystem {
  constructor() {
    this.conversationHistory = new Map();
  }

  // Respostas variadas para cada situação
  responses = {
    greetings: [
      "Oi! Que alegria te ver aqui! 😊 Sou a Ana do Mercado dos Sabores! Como posso te ajudar hoje?",
      "Olá! Bem-vindo(a) à loja mais saborosa da cidade! 🎉 Em que posso ser útil?",
      "Oi! Tudo bem? 😄 Aqui é a Ana do Mercado dos Sabores! Fico feliz em te atender!",
      "Hey! Que bom você veio! 🍫 Sou a Ana, como posso tornar seu dia mais doce hoje?"
    ],
    
    thanks: [
      "Ah, que gentil! 💖 Obrigada pelo carinho! Se precisar de mais alguma coisa, estou aqui!",
      "Eu quem agradeço pela preferência! 🥰 Volte sempre que quiser!",
      "Obrigada você! 😊 Foi um prazer te atender! Espero ver você em breve!",
      "Que fofo! 💝 Muito obrigada! Se tiver mais dúvidas, pode me chamar!",
      "Ah, obrigada! 🎀 Fico feliz em poder ajudar! Até a próxima!"
    ],
    
    farewells: [
      "Até mais! Espero te ver em breve! 😊🍫",
      "Tchau! Volte sempre! 🥰",
      "Até logo! Tenha um dia docinho! 🎂",
      "Foi um prazer! Até a próxima! 💝"
    ],
    
    compliments: [
      "Ah, que amor! 💖 Obrigada! Fico feliz que gostou!",
      "Nossa, obrigada! 🥰 Isso me deixa muito feliz!",
      "Que gentileza! 😊 Obrigada pelo elogio!",
      "Ah, você é muito fofo(a)! 💝 Obrigada!"
    ],
    
    menu: [
      `🍫 **BROWNIES (R$ 4,00)**
• Ferrero - Intenso com brigadeiro 50% cacau
• Doce de Leite - Cremosinho e delicioso  
• Ninho - Molhadinho com leite Ninho
• Paçoca - Amanteigado com paçoca
• Pistache - Crocante por fora, molhadinho por dentro
• Brigadeiro - Clássico e irresistível

🍨 **DINDINS (R$ 5,50-6,00)**
• Oreo - Clássico e amado
• Ninho com Avelã - Combinação perfeita
• Ninho com Morango - Doce e frutado
• Paçoca - Sabor brasileiro
• Browninho - Para os amantes de chocolate

🎂 **BOLOS NO POTE**
• Ferrero - R$ 12,00
• Maracujá com Chocolate - R$ 12,00  
• Ninho com Morango - R$ 11,00

💻 *Confira fotos e faça pedidos:* https://lojams.rf.gd`,

      `📋 **NOSSA LINHA COMPLETA:**

🍫 BROWNIES ARTESANAIS - R$ 4,00
Ferrero, Doce de Leite, Ninho, Paçoca, Pistache e Brigadeiro

🍨 DINDINS GOURMET - R$ 5,50-6,00
Oreo, Ninho com Avelã, Ninho com Morango, Paçoca e Browninho

🎂 BOLOS NO POTE - R$ 11,00-12,00
Ferrero, Maracujá com Chocolate, Ninho com Morango

🌐 *Detalhes completos:* https://lojams.rf.gd`
    ],
    
    prices: [
      "💰 **NOSSOS PREÇOS DOCINHOS:**\n• Brownies: R$ 4,00 cada\n• Dindins: R$ 5,50 a R$ 6,00\n• Bolos no Pote: R$ 11,00 a R$ 12,00\n\n💡 *Dica:* Qual produto te interessou mais?",
      "🎯 **INVESTIMENTO EM DOCES:**\n🍫 Brownies: R$ 4,00\n🍨 Dindins: R$ 5,50-6,00\n🎂 Bolos no Pote: R$ 11,00-12,00\n\nAlgum te chamou atenção? 😊"
    ],
    
    address: [
      "📍 **NOSSO CANTINHO DOCE:**\nRua Raimundo Lemos Dias, 68\n\nÉ aqui que a magia acontece! 🎉 Você pode vir retirar seu pedido!",
      "🏠 **ONDE ESTAMOS:**\nRua Raimundo Lemos Dias, 68\n\nAqui é onde preparamos tudo com carinho! 🥰 Venha nos visitar!"
    ],
    
    payment: [
      "💳 **FORMAS DE PAGAMENTO:**\n• PIX (super prático!)\n• Dinheiro\n\nFacilitamos para você! 😊",
      "💰 **COMO PAGAR:**\n✓ PIX\n✓ Dinheiro\n\nSimples e fácil, né? 💝"
    ],
    
    website: [
      "🌐 **NOSSO SITE:** https://lojams.rf.gd\n\nLá você encontra:\n• Fotos lindas de todos os produtos\n• Cardápio completo\n• Sistema de pedidos online\n• Todas as informações!\n\nÉ bem fácil de usar! 🥰",
      "💻 **PEDIDOS ONLINE:** https://lojams.rf.gd\n\nNo site é super prático:\n📸 Ver todas as fotos\n📋 Cardápio detalhado\n🛒 Fazer pedidos\n📞 Falar conosco\n\nVai adorar a experiência! 😄"
    ],
    
    default: [
      "Olá! Sou a Ana do Mercado dos Sabores! 😊\nPosso te ajudar com:\n• 📋 Cardápio completo\n• 💰 Preços\n• 📍 Endereço\n• 💳 Formas de pagamento\n• 🌐 Site de pedidos\n\nO que você gostaria de saber?",
      "Oi! Tudo bem? 😄 Aqui é a Ana!\nEstou aqui para te ajudar a descobrir nossos doces deliciosos! 🍫\n\nDo que você está com vontade hoje?",
      "Hey! Bem-vindo(a)! 🎉\nSou a Ana e vou te guiar pelo mundo dos sabores!\n\nMe conta: está procurando algo específico ou quer conhecer nosso cardápio?",
      "Olá! Que bom te ver por aqui! 🥰\nSou a Ana - sua especialista em doces!\n\nPosso te mostrar nossas delícias ou tirar alguma dúvida?"
    ]
  };

  getRandomResponse(category) {
    const responses = this.responses[category] || this.responses.default;
    return responses[Math.floor(Math.random() * responses.length)];
  }

  generateResponse(userMessage, senderName = '') {
    const message = userMessage.toLowerCase().trim();
    const namePart = senderName ? `, ${senderName}` : '';
    
    // Saudações
    if (this.isGreeting(message)) {
      return this.getRandomResponse('greetings');
    }
    
    // Agradecimentos
    if (this.isThanks(message)) {
      return this.getRandomResponse('thanks');
    }
    
    // Despedidas
    if (this.isFarewell(message)) {
      return this.getRandomResponse('farewells');
    }
    
    // Elogios
    if (this.isCompliment(message)) {
      return this.getRandomResponse('compliments');
    }
    
    // Cardápio
    if (this.isMenuRequest(message)) {
      return this.getRandomResponse('menu');
    }
    
    // Preços
    if (this.isPriceRequest(message)) {
      return this.getRandomResponse('prices');
    }
    
    // Endereço
    if (this.isAddressRequest(message)) {
      return this.getRandomResponse('address');
    }
    
    // Pagamento
    if (this.isPaymentRequest(message)) {
      return this.getRandomResponse('payment');
    }
    
    // Website
    if (this.isWebsiteRequest(message)) {
      return this.getRandomResponse('website');
    }
    
    // Produtos específicos
    const productResponse = this.getProductResponse(message);
    if (productResponse) {
      return productResponse;
    }
    
    // Resposta padrão variada
    return this.getRandomResponse('default');
  }

  isGreeting(message) {
    const greetings = ['oi', 'olá', 'ola', 'eae', 'opa', 'hey', 'hi', 'hello', 'boa tarde', 'boa noite', 'bom dia'];
    return greetings.some(greet => message.includes(greet));
  }

  isThanks(message) {
    const thanks = ['obrigado', 'obrigada', 'valeu', 'agradeço', 'agradecido', 'agradecida', 'brigado', 'brigada'];
    return thanks.some(thank => message.includes(thank));
  }

  isFarewell(message) {
    const farewells = ['tchau', 'bye', 'até', 'flw', 'falou', 'adeus', 'xau'];
    return farewells.some(farewell => message.includes(farewell));
  }

  isCompliment(message) {
    const compliments = ['lindo', 'linda', 'bonito', 'bonita', 'maravilhoso', 'maravilhosa', 'perfeito', 'perfeita', 'amo', 'adoro', 'incrível'];
    return compliments.some(compliment => message.includes(compliment));
  }

  isMenuRequest(message) {
    return message.includes('cardápio') || message.includes('menu') || message.includes('produto') || message.includes('o que tem') || message.includes('o que vocês têm');
  }

  isPriceRequest(message) {
    return message.includes('preço') || message.includes('quanto') || message.includes('valor') || message.includes('custa');
  }

  isAddressRequest(message) {
    return message.includes('endereço') || message.includes('onde fica') || message.includes('localização') || message.includes('retirada');
  }

  isPaymentRequest(message) {
    return message.includes('pagamento') || message.includes('pix') || message.includes('dinheiro') || message.includes('cartão') || message.includes('forma de pagamento');
  }

  isWebsiteRequest(message) {
    return message.includes('site') || message.includes('online') || message.includes('encomenda') || message.includes('pedido') || message.includes('internet');
  }

  getProductResponse(message) {
    const products = {
      'brownie': {
        responses: [
          "🍫 **BROWNIES - R$ 4,00 cada**\nTemos:\n• Ferrero (o mais pedido!)\n• Doce de Leite\n• Ninho\n• Paçoca\n• Pistache\n• Brigadeiro\n\nQual te dá mais vontade? 😋",
          "🎯 **NOSSO TIME DE BROWNIES:**\nTodos por R$ 4,00!\n✓ Ferrero - Intenso\n✓ Doce de Leite - Cremoso\n✓ Ninho - Fofinho\n✓ Paçoca - Amanteigado\n✓ Pistache - Sofisticado\n✓ Brigadeiro - Clássico\n\nTem algum favorito? 🥰"
        ]
      },
      'dindin': {
        responses: [
          "🍨 **DINDINS GOURMET:**\n• Oreo - R$ 5,50\n• Ninho com Avelã - R$ 6,00\n• Ninho com Morango - R$ 6,00\n• Paçoca - R$ 5,50\n• Browninho - R$ 5,50\n\nQual sabor te conquista? 😊",
          "🎉 **LINHA DINDIN:**\nPreços docinhos:\n🍪 Oreo: R$ 5,50\n🥜 Ninho com Avelã: R$ 6,00\n🍓 Ninho com Morango: R$ 6,00\n🌰 Paçoca: R$ 5,50\n🍫 Browninho: R$ 5,50\n\nTem algum preferido? 💝"
        ]
      },
      'bolo': {
        responses: [
          "🎂 **BOLOS NO POTE:**\n• Ferrero - R$ 12,00\n• Maracujá com Chocolate - R$ 12,00\n• Ninho com Morango - R$ 11,00\n\nPerfeitos para presentear ou se presentear! 🥰",
          "💝 **BOLOS ESPECIAIS:**\nTodos no pote, práticos e deliciosos!\n⭐ Ferrero: R$ 12,00\n⭐ Maracujá com Chocolate: R$ 12,00\n⭐ Ninho com Morango: R$ 11,00\n\nQual te faz sorrir? 😊"
        ]
      },
      'ferrero': {
        responses: [
          "🍫 **Brownie Ferrero - R$ 4,00**\nNosso best-seller! Brownie intenso com recheio cremoso de brigadeiro 50% cacau. Uma experiência inesquecível! 😍",
          "⭐ **Brownie Ferrero - R$ 4,00**\nO queridinho dos clientes! Combinação perfeita de brownie e brigadeiro premium. Simplesmente divino! 💖"
        ]
      },
      'ninho': {
        responses: [
          "🥛 **Brownie Ninho - R$ 4,00**\nMolhadinho com recheio cremoso de leite Ninho. Uma fofura que derrete na boca! 🥰",
          "💫 **Brownie Ninho - R$ 4,00**\nPara os amantes de leite Ninho! Textura fofinha e sabor que acolhe o coração. Perfeito! ✨"
        ]
      }
    };

    for (const [product, data] of Object.entries(products)) {
      if (message.includes(product)) {
        const responses = data.responses;
        return responses[Math.floor(Math.random() * responses.length)];
      }
    }

    return null;
  }
}

const fallbackSystem = new IntelligentFallbackSystem();

// Função para obter resposta da IA do GitHub
async function getGitHubAIResponse(userMessage, senderName = '') {
  if (!GITHUB_API_CONFIG.apiKey) {
    console.log("⚠️ Usando fallback inteligente - GITHUB_TOKEN não configurado");
    return fallbackSystem.generateResponse(userMessage, senderName);
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
        temperature: 0.8, // Mais criativo
        top_p: 0.9,
        frequency_penalty: 0.5, // Evita repetições
        presence_penalty: 0.3
      })
    });

    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status}`);
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
    return fallbackSystem.generateResponse(userMessage, senderName);
  }
}

// Rotas da API
app.get('/', (req, res) => {
  res.json({ 
    message: 'API do Mercado dos Sabores funcionando!',
    status: 'online',
    mode: 'GitHub AI + Fallback Inteligente Avançado',
    features: 'Respostas variadas, conversação natural, personalidade própria'
  });
});

// Rota do webhook principal
app.post('/webhook', async (req, res) => {
  console.log('📩 Mensagem recebida:', req.body);
  
  const { senderMessage, senderName, isMessageFromGroup } = req.body;
  
  if (isMessageFromGroup) {
    return res.json({ data: [{ message: "" }] });
  }
  
  try {
    const resposta = await getGitHubAIResponse(senderMessage, senderName);
    console.log(`💬 Resposta para ${senderName}: ${resposta.substring(0, 100)}...`);
    
    res.json({
      data: [{ message: resposta }]
    });
  } catch (error) {
    console.error('Erro no webhook:', error);
    const fallback = fallbackSystem.generateResponse(senderMessage, senderName);
    res.json({ data: [{ message: fallback }] });
  }
});

// Rota de teste
app.get('/test', async (req, res) => {
  const { message } = req.query;
  
  if (!message) {
    return res.json({ error: 'Forneça o parâmetro ?message=...' });
  }
  
  try {
    const resposta = await getGitHubAIResponse(message);
    res.json({
      original: message,
      response: resposta,
      source: 'github-ai',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  console.log(`🔗 Webhook: http://localhost:${PORT}/webhook`);
  console.log(`🤖 Modo: IA Conversacional Avançada`);
  console.log(`🎭 Personalidade: Ana - Atendente do Mercado dos Sabores`);
  console.log(`🔄 Sistema: Respostas variadas e naturais`);
});
