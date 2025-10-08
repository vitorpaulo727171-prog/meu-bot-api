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

// Sistema de memória de conversação
class ConversationMemory {
  constructor() {
    this.conversations = new Map();
    this.maxHistory = 6; // Mantém as últimas 3 trocas de mensagens
  }

  getConversation(userId) {
    if (!this.conversations.has(userId)) {
      this.conversations.set(userId, {
        history: [],
        lastInteraction: Date.now(),
        context: {}
      });
    }
    return this.conversations.get(userId);
  }

  addMessage(userId, role, content) {
    const conversation = this.getConversation(userId);
    conversation.history.push({ role, content, timestamp: Date.now() });
    conversation.lastInteraction = Date.now();
    
    // Manter apenas o histórico mais recente
    if (conversation.history.length > this.maxHistory) {
      conversation.history = conversation.history.slice(-this.maxHistory);
    }
  }

  getHistory(userId) {
    const conversation = this.getConversation(userId);
    return conversation.history;
  }

  updateContext(userId, key, value) {
    const conversation = this.getConversation(userId);
    conversation.context[key] = value;
  }

  getContext(userId) {
    const conversation = this.getConversation(userId);
    return conversation.context;
  }

  // Limpar conversas antigas (mais de 1 hora)
  cleanup() {
    const now = Date.now();
    const oneHour = 60 * 60 * 1000;
    
    for (const [userId, conversation] of this.conversations.entries()) {
      if (now - conversation.lastInteraction > oneHour) {
        this.conversations.delete(userId);
      }
    }
  }
}

const memory = new ConversationMemory();

// Fazer cleanup a cada hora
setInterval(() => memory.cleanup(), 60 * 60 * 1000);

// Sistema de mensagem com contexto
function getSystemMessage(userId) {
  const context = memory.getContext(userId);
  
  return `Você é a Ana, atendente virtual da loja "Mercado dos Sabores". Mantenha o contexto da conversa e seja natural.

IMPORTANTE: Você DEVE lembrar da conversa anterior e continuar de onde parou.

CONTEXTO ATUAL:
${context.currentProduct ? `- Cliente interessado em: ${context.currentProduct}` : ''}
${context.askedAbout ? `- Já falamos sobre: ${context.askedAbout}` : ''}

COMO CONVERSAR:
- Lembre-se do que foi dito antes
- Continue a conversa naturalmente
- Faça perguntas relevantes baseadas no histórico
- Não repita informações já dadas
- Seja proativa em ajudar a concluir o pedido

CATÁLOGO DA LOJA:

🍫 BROWNIES (R$ 4,00 cada):
• Brownie Ferrero - Intenso com brigadeiro 50% cacau
• Brownie Doce de Leite - Cremoso e suave
• Brownie Ninho - Com leite Ninho
• Brownie Paçoca - Sabor amendoim
• Brownie Pistache - Sofisticado
• Brownie Brigadeiro - Clássico

🍨 DINDINS GOURMET:
• Dindin Oreo - R$ 5,50
• Dindin Ninho com Avelã - R$ 6,00
• Dindin Ninho com Morango - R$ 6,00
• Dindin Paçoca - R$ 5,50
• Dindin Browninho - R$ 5,50

🎂 BOLOS NO POTE:
• Bolo de Pote Ferrero - R$ 12,00
• Bolo de Pote Maracujá com Chocolate - R$ 12,00
• Bolo de Pote Ninho com Morango - R$ 11,00

INFORMAÇÕES:
• Endereço: Rua Raimundo Lemos Dias, 68
• Pagamento: PIX e Dinheiro
• Site: https://lojams.rf.gd

DIRETRIZES:
- SEMPRE mantenha o contexto da conversa
- Faça perguntas para entender melhor o que o cliente quer
- Ajude a fechar o pedido naturalmente
- Se o cliente mencionar um produto, pergunte detalhes`;
}

// Sistema de fallback com memória
class IntelligentFallbackSystem {
  constructor() {
    this.conversations = new Map();
  }

  generateResponse(userMessage, senderName = '') {
    const userId = senderName || 'default';
    const conversation = this.getConversation(userId);
    
    // Adicionar mensagem atual ao histórico
    conversation.history.push({ role: 'user', content: userMessage });
    
    // Manter histórico limitado
    if (conversation.history.length > 6) {
      conversation.history = conversation.history.slice(-6);
    }
    
    // Analisar contexto da conversa
    const context = this.analyzeContext(conversation.history);
    
    // Gerar resposta baseada no contexto
    const response = this.generateContextualResponse(userMessage, context, conversation);
    
    // Adicionar resposta ao histórico
    conversation.history.push({ role: 'assistant', content: response });
    
    return response;
  }

  getConversation(userId) {
    if (!this.conversations.has(userId)) {
      this.conversations.set(userId, {
        history: [],
        context: {},
        lastInteraction: Date.now()
      });
    }
    return this.conversations.get(userId);
  }

  analyzeContext(history) {
    const context = {
      mentionedProducts: [],
      askedAboutPrices: false,
      askedAboutMenu: false,
      currentInterest: null,
      stage: 'greeting' // greeting, browsing, deciding, ordering
    };

    // Analisar histórico para entender contexto
    const allMessages = history.map(msg => msg.content.toLowerCase()).join(' ');
    
    // Detectar produtos mencionados
    const products = ['brownie', 'dindin', 'bolo', 'ferrero', 'ninho', 'paçoca', 'oreo', 'avelã', 'maracujá'];
    products.forEach(product => {
      if (allMessages.includes(product)) {
        context.mentionedProducts.push(product);
      }
    });

    // Detectar estágio da conversa
    if (allMessages.includes('preço') || allMessages.includes('quanto')) {
      context.askedAboutPrices = true;
    }
    
    if (allMessages.includes('cardápio') || allMessages.includes('menu')) {
      context.askedAboutMenu = true;
    }

    // Determinar estágio atual
    if (context.mentionedProducts.length > 0) {
      context.currentInterest = context.mentionedProducts[0];
      context.stage = 'deciding';
    } else if (context.askedAboutMenu || context.askedAboutPrices) {
      context.stage = 'browsing';
    }

    return context;
  }

  generateContextualResponse(message, context, conversation) {
    const lowerMsg = message.toLowerCase();
    
    // Se é continuação de uma conversa sobre produtos
    if (context.stage === 'deciding' && context.currentInterest) {
      return this.continueProductConversation(message, context, conversation);
    }
    
    // Respostas iniciais (sem contexto ainda)
    return this.getInitialResponse(message, context);
  }

  continueProductConversation(message, context, conversation) {
    const product = context.currentInterest;
    const lowerMsg = message.toLowerCase();
    
    // Respostas para continuar conversa sobre brownies
    if (product === 'brownie') {
      if (lowerMsg.includes('ferrero') || lowerMsg.includes('1')) {
        return "🍫 **Brownie Ferrero - R$ 4,00**\nExcelente escolha! É nosso best-seller! 😍\n\nÉ um brownie intenso com recheio cremoso de brigadeiro 50% cacau. Uma verdadeira tentação!\n\nVocê gostaria de encomendar alguns? Posso te passar o site para pedidos: https://lojams.rf.gd";
      }
      else if (lowerMsg.includes('ninho') || lowerMsg.includes('2')) {
        return "🥛 **Brownie Ninho - R$ 4,00**\nAh, ótima pedida! É super fofinho e cremoso! 🥰\n\nPerfeito para quem ama leite Ninho. Derrete na boca!\n\nVai querer experimentar? O site para pedidos é: https://lojams.rf.gd";
      }
      else if (lowerMsg.includes('paçoca') || lowerMsg.includes('3')) {
        return "🌰 **Brownie Paçoca - R$ 4,00**\nNossa, esse é uma delícia! Combinação perfeita! 😋\n\nBrownie amanteigado com recheio cremoso de paçoca. Um clássico!\n\nPosso te ajudar com o pedido? Acesse: https://lojams.rf.gd";
      }
      else if (!isNaN(parseInt(message.trim()))) {
        const options = {
          1: "ferrero",
          2: "ninho", 
          3: "paçoca",
          4: "doce de leite",
          5: "pistache",
          6: "brigadeiro"
        };
        const selected = options[parseInt(message.trim())];
        if (selected) {
          return `🍫 **Brownie ${selected.charAt(0).toUpperCase() + selected.slice(1)} - R$ 4,00**\nÓtima escolha! Esse é uma delícia! 😊\n\nQuer que eu te explique mais sobre esse sabor ou já vai querer encomendar?\n\nSite: https://lojams.rf.gd`;
        }
      }
      else if (lowerMsg.includes('sim') || lowerMsg.includes('quero') || lowerMsg.includes('vou')) {
        return "🎉 Perfeito! Para fazer seu pedido, acesse nosso site:\nhttps://lojams.rf.gd\n\nLá você pode:\n• Escolher a quantidade\n• Ver todas as fotos\n• Fazer o pedido online\n• Combinar a retirada\n\nAlguma dúvida sobre como fazer o pedido?";
      }
      else if (lowerMsg.includes('não') || lowerMsg.includes('nao')) {
        return "Tudo bem! 😊\n\nQuer conhecer nossos outros produtos? Temos dindins gourmet e bolos no pote também!\n\nOu prefere pensar mais sobre os brownies?";
      }
    }

    // Resposta padrão para continuidade
    return `Entendi! Continuando sobre ${product}... 😊\n\nVocê tem alguma dúvida específica ou já quer fazer o pedido?\n\nSite: https://lojams.rf.gd`;
  }

  getInitialResponse(message, context) {
    const lowerMsg = message.toLowerCase();
    
    // Detectar intenções específicas
    if (lowerMsg.includes('brownie') || lowerMsg.includes('quero comprar brownie')) {
      context.currentInterest = 'brownie';
      context.stage = 'deciding';
      
      return `🍫 **BROWNIES - R$ 4,00 cada**\nQue bom que quer brownies! São uma delícia! 😍\n\nTemos esses sabores:\n1️⃣ Ferrero (o mais pedido!)\n2️⃣ Ninho \n3️⃣ Paçoca\n4️⃣ Doce de Leite\n5️⃣ Pistache\n6️⃣ Brigadeiro\n\nQual te dá mais vontade? Pode me dizer pelo número ou nome!`;
    }
    
    // Respostas para outras situações (mantenha as anteriores)
    if (lowerMsg.includes('oi') || lowerMsg.includes('olá')) {
      return "Oi! Que alegria te ver aqui! 😊 Sou a Ana do Mercado dos Sabores! Como posso te ajudar hoje?";
    }
    
    if (lowerMsg.includes('cardápio') || lowerMsg.includes('menu')) {
      return `📋 **NOSSO CARDÁPIO:**\n\n🍫 BROWNIES (R$ 4,00)\n🍨 DINDINS (R$ 5,50-6,00)  \n🎂 BOLOS NO POTE (R$ 11,00-12,00)\n\nQual produto te interessa mais? 😊`;
    }
    
    // Resposta padrão
    return "Olá! Sou a Ana do Mercado dos Sabores! 😊\nPosso te ajudar com brownies, dindins, bolos no pote... O que você está procurando?";
  }
}

const fallbackSystem = new IntelligentFallbackSystem();

// Função principal da IA com memória
async function getGitHubAIResponse(userMessage, senderName = '') {
  const userId = senderName || 'default';
  
  if (!GITHUB_API_CONFIG.apiKey) {
    console.log("⚠️ Usando fallback com memória");
    return fallbackSystem.generateResponse(userMessage, senderName);
  }

  try {
    // Adicionar mensagem do usuário ao histórico
    memory.addMessage(userId, 'user', userMessage);
    
    // Obter histórico da conversa
    const history = memory.getHistory(userId);
    
    // Atualizar contexto baseado na mensagem atual
    updateContext(userId, userMessage);
    
    console.log("🔄 Chamando GitHub AI com histórico...");
    
    const messages = [
      {
        role: "system",
        content: getSystemMessage(userId)
      },
      ...history,
      {
        role: "user",
        content: userMessage
      }
    ];

    const response = await fetch(`${GITHUB_API_CONFIG.endpoint}/openai/deployments/${GITHUB_API_CONFIG.model}/chat/completions?api-version=2023-12-01-preview`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GITHUB_API_CONFIG.apiKey}`,
        'api-key': GITHUB_API_CONFIG.apiKey
      },
      body: JSON.stringify({
        messages: messages,
        max_tokens: 500,
        temperature: 0.8,
        top_p: 0.9,
        frequency_penalty: 0.5,
        presence_penalty: 0.3
      })
    });

    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status}`);
    }

    const data = await response.json();
    
    if (data.choices && data.choices[0].message) {
      const aiResponse = data.choices[0].message.content;
      
      // Adicionar resposta da IA ao histórico
      memory.addMessage(userId, 'assistant', aiResponse);
      
      console.log("✅ Resposta da IA com memória recebida");
      return aiResponse;
    } else {
      throw new Error('Resposta inválida da API');
    }

  } catch (error) {
    console.error('❌ Erro GitHub AI:', error.message);
    return fallbackSystem.generateResponse(userMessage, senderName);
  }
}

// Função para atualizar contexto
function updateContext(userId, userMessage) {
  const lowerMsg = userMessage.toLowerCase();
  const context = memory.getContext(userId);
  
  // Detectar produtos mencionados
  if (lowerMsg.includes('brownie')) {
    context.currentProduct = 'brownies';
    context.askedAbout = 'brownies';
  } else if (lowerMsg.includes('dindin')) {
    context.currentProduct = 'dindins';
    context.askedAbout = 'dindins';
  } else if (lowerMsg.includes('bolo')) {
    context.currentProduct = 'bolos no pote';
    context.askedAbout = 'bolos no pote';
  }
  
  // Atualizar contexto na memória
  memory.updateContext(userId, 'currentProduct', context.currentProduct);
  memory.updateContext(userId, 'askedAbout', context.askedAbout);
}

// Rotas da API
app.get('/', (req, res) => {
  res.json({ 
    message: 'API do Mercado dos Sabores funcionando!',
    status: 'online',
    features: 'Memória de conversação ativa - IA lembra do contexto',
    active_conversations: memory.conversations.size
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

// Rota para ver conversas ativas (apenas para debug)
app.get('/conversations', (req, res) => {
  const conversations = {};
  
  for (const [userId, data] of memory.conversations.entries()) {
    conversations[userId] = {
      history: data.history,
      context: data.context,
      lastInteraction: new Date(data.lastInteraction).toISOString()
    };
  }
  
  res.json({
    active_conversations: memory.conversations.size,
    conversations: conversations
  });
});

// Rota para limpar conversa específica
app.delete('/conversation/:userId', (req, res) => {
  const userId = req.params.userId;
  memory.conversations.delete(userId);
  res.json({ message: `Conversa de ${userId} limpa` });
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  console.log(`🔗 Webhook: http://localhost:${PORT}/webhook`);
  console.log(`🧠 Sistema: Memória de conversação ATIVA`);
  console.log(`💾 Armazenamento: ${memory.conversations.size} conversas`);
});
