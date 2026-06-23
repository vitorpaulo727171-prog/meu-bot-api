const express = require('express');
const OpenAI = require('openai');
const mysql = require('mysql2/promise');

const app = express();
app.use(express.json());

// ============================================
// 1. CONFIGURAÇÕES DAS APIS IPTV - VS SOLUÇÕES
// ============================================
const IPTV_APIS = [
  {
    id: 1,
    name: 'OCTANE COM ADULTO',
    url: 'https://multserver.dashboardgs.store/api/chatbot/MeWeEg8WnN/o231qMN14q'
  },
  {
    id: 2,
    name: 'OBA W2 COM ADULTO',
    url: 'https://multserver.dashboardgs.store/api/chatbot/MeWeEg8WnN/aYB1wQNDvm'
  },
  {
    id: 3,
    name: 'UNITV HORIZON',
    url: 'https://multserver.dashboardgs.store/api/chatbot/MeWeEg8WnN/rlKWOzlDzo'
  },
  {
    id: 4,
    name: 'HORIZON COM ADULTO',
    url: 'https://multserver.dashboardgs.store/api/chatbot/MeWeEg8WnN/qK4Wr0YLeN'
  },
  {
    id: 5,
    name: 'OLYMPUS PLAYER COM ADULTO',
    url: 'https://multserver.dashboardgs.store/api/chatbot/MeWeEg8WnN/PkaL4RJWgr'
  },
  {
    id: 6,
    name: 'BOX PLAYER OFICIAL',
    url: 'https://multserver.dashboardgs.store/api/chatbot/MeWeEg8WnN/nVrW8M61Ka'
  }
];

// ============================================
// 2. CONFIGURAÇÕES DA IA (OpenAI via GitHub)
// ============================================
const API_KEYS = [
  process.env.GITHUB_TOKEN_1,
  process.env.GITHUB_TOKEN_2,
  process.env.GITHUB_TOKEN_3,
  process.env.GITHUB_TOKEN_4,
].filter(Boolean);

const endpoint = "https://models.github.ai/inference";
const model = "openai/gpt-4.1";

let currentApiIndex = 0;
let rateLimitStats = {};

if (API_KEYS.length === 0) {
  console.error("ERRO: Nenhuma GITHUB_TOKEN encontrada");
  process.exit(1);
}
console.log(`🔑 ${API_KEYS.length} chaves API configuradas`);

// ============================================
// 3. MYSQL (Railway)
// ============================================
const MYSQL_CONNECTION_STRING = "mysql://root:ZefFlJwoGgbGclwcSyOeZuvMGVqmhvtH@trolley.proxy.rlwy.net:52398/railway";

function parseMySQLString(connectionString) {
  const matches = connectionString.match(/mysql:\/\/([^:]+):([^@]+)@([^:]+):(\d+)\/(.+)/);
  if (matches) {
    return {
      host: matches[3],
      port: parseInt(matches[4]),
      user: matches[1],
      password: matches[2],
      database: matches[5],
      connectTimeout: 10000,
      acquireTimeout: 10000,
      timeout: 10000,
      charset: 'utf8mb4'
    };
  }
  return null;
}

const dbConfig = parseMySQLString(MYSQL_CONNECTION_STRING) || {
  host: process.env.MYSQLHOST,
  port: process.env.MYSQLPORT || 3306,
  user: process.env.MYSQLUSER,
  password: process.env.MYSQLPASSWORD,
  database: process.env.MYSQLDATABASE,
  connectTimeout: 10000,
  acquireTimeout: 10000,
  timeout: 10000,
  charset: 'utf8mb4'
};

let pool;
let mysqlEnabled = false;

// ============================================
// 4. FUNÇÕES AUXILIARES
// ============================================
function getCurrentDateTime() {
  const now = new Date();
  now.setTime(now.getTime() - 3 * 60 * 60 * 1000);
  const day = String(now.getDate()).padStart(2, '0');
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const year = now.getFullYear();
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  return {
    date: `${day}/${month}/${year}`,
    time: `${hours}:${minutes}:${seconds}`,
    full: `${day}/${month}/${year} ${hours}:${minutes}:${seconds}`,
    weekday: now.toLocaleDateString('pt-BR', { weekday: 'long' }),
    timestamp: now.getTime()
  };
}

function getCurrentClient() {
  const token = API_KEYS[currentApiIndex];
  return new OpenAI({
    baseURL: endpoint,
    apiKey: token
  });
}

function rotateToNextApi() {
  const oldIndex = currentApiIndex;
  currentApiIndex = (currentApiIndex + 1) % API_KEYS.length;
  if (!rateLimitStats[oldIndex]) {
    rateLimitStats[oldIndex] = { rateLimitedAt: new Date() };
  } else {
    rateLimitStats[oldIndex].rateLimitedAt = new Date();
  }
  console.log(`🔄 Rotacionando API: ${oldIndex} → ${currentApiIndex}`);
  return getCurrentClient();
}

async function callAIWithFallback(messages, maxRetries = API_KEYS.length) {
  let lastError;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const client = getCurrentClient();
    const currentTokenIndex = currentApiIndex;
    try {
      console.log(`🤖 Tentando API ${currentTokenIndex} (tentativa ${attempt + 1}/${maxRetries})`);
      const response = await client.chat.completions.create({
        messages: messages,
        temperature: 0.3,
        top_p: 1.0,
        model: model
      });
      console.log(`✅ Sucesso com API ${currentTokenIndex}`);
      return response;
    } catch (error) {
      lastError = error;
      if (error.code === 'RateLimitReached' || error.message?.includes('Rate limit')) {
        console.log(`⏰ Rate limit na API ${currentTokenIndex}`);
        rotateToNextApi();
        if (attempt < maxRetries - 1) continue;
      } else {
        console.error(`❌ Erro na API ${currentTokenIndex}:`, error.message);
        if (attempt < maxRetries - 1) {
          rotateToNextApi();
          continue;
        }
      }
    }
  }
  throw lastError || new Error('Todas as APIs falharam');
}

// ============================================
// 5. FUNÇÕES DE IPTV - VS SOLUÇÕES
// ============================================
async function generateIptvTest(apiIndex = 0) {
  const api = IPTV_APIS[apiIndex % IPTV_APIS.length];
  console.log(`📡 Gerando teste IPTV via: ${api.name} (${api.url})`);

  try {
    const response = await fetch(api.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    console.log(`✅ Teste IPTV gerado com sucesso - ${api.name}`);

    // Pega o reply completo da API
    let reply = data.reply || '';

    // Se o reply estiver vazio, monta uma mensagem básica com os campos principais
    if (!reply) {
      reply = `📺 *TESTE IPTV - ${api.name}*\n\n`;
      reply += `📦 *Plano:* ${data.package || 'N/A'}\n`;
      reply += `🔗 *DNS:* ${data.dns || 'N/A'}\n`;
      reply += `👤 *Usuário:* ${data.username || 'N/A'}\n`;
      reply += `🔒 *Senha:* ${data.password || 'N/A'}\n`;
      reply += `📶 *Conexões:* ${data.connections || 1}\n`;
      reply += `⏳ *Expira em:* ${data.expiresAtFormatted || data.expiresAt || 'N/A'}\n`;
      if (data.payUrl) reply += `💳 *Assinar:* ${data.payUrl}\n`;
    } else {
      // Adiciona um cabeçalho com o nome do servidor
      reply = `📺 *TESTE IPTV - ${api.name}*\n\n` + reply;
    }

    return {
      success: true,
      message: reply,
      raw: data,
      apiName: api.name,
      apiId: api.id
    };

  } catch (error) {
    console.error(`❌ Erro ao gerar teste IPTV:`, error.message);
    return {
      success: false,
      message: `❌ Desculpe, não foi possível gerar um teste agora. Tente novamente em alguns instantes.`
    };
  }
}

// ============================================
// 6. FUNÇÕES DO BANCO DE DADOS
// ============================================
async function testMySQLConnection() {
  try {
    const testConnection = await mysql.createConnection(dbConfig);
    await testConnection.execute('SELECT 1 as test');
    await testConnection.end();
    return true;
  } catch (error) {
    console.error('❌ Teste de conexão MySQL falhou:', error.message);
    return false;
  }
}

async function initializeDatabase() {
  console.log('🔄 Inicializando MySQL...');
  if (!dbConfig.host || !dbConfig.user || !dbConfig.password || !dbConfig.database) {
    console.log('🚫 Configurações do MySQL incompletas');
    mysqlEnabled = false;
    return;
  }

  const connectionTest = await testMySQLConnection();
  if (!connectionTest) {
    console.log('🚫 MySQL desabilitado');
    mysqlEnabled = false;
    return;
  }

  try {
    pool = mysql.createPool({
      ...dbConfig,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      acquireTimeout: 10000,
      timeout: 10000,
    });

    const connection = await pool.getConnection();

    await connection.execute(`
      CREATE TABLE IF NOT EXISTS conversations (
        id INT AUTO_INCREMENT PRIMARY KEY,
        session_id VARCHAR(255) NOT NULL,
        sender_name VARCHAR(255) NOT NULL,
        group_name VARCHAR(255),
        is_group_message BOOLEAN DEFAULT FALSE,
        sender_message TEXT NOT NULL,
        ai_response TEXT NOT NULL,
        message_datetime BIGINT,
        receive_message_app VARCHAR(100),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await connection.execute(`
      CREATE TABLE IF NOT EXISTS iptv_plans (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        description TEXT,
        price DECIMAL(10,2) NOT NULL,
        duration_days INT NOT NULL,
        channels INT NOT NULL,
        active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    console.log('✅ Tabelas verificadas/criadas');
    connection.release();
    mysqlEnabled = true;
    console.log('🎉 MySQL inicializado com sucesso!');

  } catch (error) {
    console.error('❌ Erro na inicialização do MySQL:', error.message);
    mysqlEnabled = false;
    if (pool) {
      try { await pool.end(); } catch (e) {}
      pool = null;
    }
  }
}

function generateSessionId(senderName, groupName, isMessageFromGroup) {
  if (isMessageFromGroup && groupName) {
    return `group_${groupName}_user_${senderName}`;
  }
  return `user_${senderName}`;
}

async function saveConversation(conversationData) {
  if (!mysqlEnabled || !pool) return null;
  try {
    const sessionId = generateSessionId(
      conversationData.senderName,
      conversationData.groupName,
      conversationData.isMessageFromGroup
    );
    const [result] = await pool.execute(
      `INSERT INTO conversations 
       (session_id, sender_name, group_name, is_group_message, sender_message, ai_response, message_datetime, receive_message_app) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        sessionId,
        conversationData.senderName || '',
        conversationData.groupName || '',
        conversationData.isMessageFromGroup ? 1 : 0,
        conversationData.senderMessage || '',
        conversationData.aiResponse || '',
        conversationData.messageDateTime || Date.now(),
        conversationData.receiveMessageApp || 'unknown'
      ]
    );
    return result.insertId;
  } catch (error) {
    console.error('❌ Erro ao salvar conversa:', error.message);
    return null;
  }
}

async function getConversationHistory(senderName, groupName, isMessageFromGroup, limit = 6) {
  if (!mysqlEnabled || !pool) return [];
  try {
    const sessionId = generateSessionId(senderName, groupName, isMessageFromGroup);
    const [rows] = await pool.execute(
      `SELECT sender_message, ai_response, created_at 
       FROM conversations 
       WHERE session_id = ? 
       ORDER BY created_at DESC 
       LIMIT ${parseInt(limit)}`,
      [sessionId]
    );
    return rows.reverse();
  } catch (error) {
    console.error('❌ Erro ao buscar histórico:', error.message);
    return [];
  }
}

async function cleanupOldMessages(senderName, groupName, isMessageFromGroup) {
  if (!mysqlEnabled || !pool) return;
  try {
    const sessionId = generateSessionId(senderName, groupName, isMessageFromGroup);
    const [recentIds] = await pool.execute(
      `SELECT id FROM conversations 
       WHERE session_id = ? 
       ORDER BY created_at DESC 
       LIMIT 15`,
      [sessionId]
    );
    if (recentIds.length > 0) {
      const keepIds = recentIds.map(row => row.id);
      const placeholders = keepIds.map(() => '?').join(',');
      await pool.execute(
        `DELETE FROM conversations 
         WHERE session_id = ? AND id NOT IN (${placeholders})`,
        [sessionId, ...keepIds]
      );
    }
  } catch (error) {
    console.error('❌ Erro ao limpar mensagens antigas:', error.message);
  }
}

async function getIptvPlans() {
  if (!mysqlEnabled || !pool) return null;
  try {
    const [rows] = await pool.execute(
      `SELECT name, description, price, duration_days, channels 
       FROM iptv_plans 
       WHERE active = 1 
       ORDER BY price ASC`
    );
    if (rows.length === 0) return "Nenhum plano disponível no momento.";
    let text = "📺 *PLANOS IPTV - VS SOLUÇÕES*\n\n";
    rows.forEach(p => {
      text += `📦 *${p.name}*\n`;
      text += `📝 ${p.description || ''}\n`;
      text += `💰 R$ ${p.price.toFixed(2)}\n`;
      text += `⏳ ${p.duration_days} dias\n`;
      text += `📡 ${p.channels} canais\n\n`;
    });
    text += `─────────────────────\n`;
    text += `💡 Para adquirir, fale com nosso suporte!`;
    return text;
  } catch (error) {
    console.error('❌ Erro ao buscar planos:', error.message);
    return null;
  }
}

// ============================================
// 7. WEBHOOK PRINCIPAL
// ============================================
app.post('/webhook', async (req, res) => {
  try {
    const {
      senderMessage,
      senderName,
      groupName,
      isMessageFromGroup,
      messageDateTime,
      receiveMessageApp
    } = req.body;

    console.log(`📩 Mensagem de ${senderName}: ${senderMessage}`);

    const currentDateTime = getCurrentDateTime();
    let aiResponse = '';
    const lowerMsg = senderMessage.toLowerCase().trim();

    // ==========================================
    // 1. LISTAR SERVIDORES
    // ==========================================
    if (lowerMsg.includes('apis') || lowerMsg.includes('lista') || lowerMsg.includes('opções') || lowerMsg.includes('quais') || lowerMsg.includes('servidores')) {
      let apiList = `📡 *SERVIDORES DISPONÍVEIS - VS SOLUÇÕES*\n\n`;
      IPTV_APIS.forEach(api => {
        apiList += `${api.id}. ${api.name}\n`;
      });
      apiList += `\n💡 Digite o *número* do servidor para gerar seu teste.`;
      apiList += `\nExemplo: *2* para OBA W2 COM ADULTO`;
      aiResponse = apiList;
    }

    // ==========================================
    // 2. NÚMERO - GERAR TESTE
    // ==========================================
    else if (/^\d+$/.test(senderMessage.trim())) {
      const number = parseInt(senderMessage.trim());
      const api = IPTV_APIS.find(a => a.id === number);
      if (api) {
        console.log(`🎯 Gerando teste para servidor ${api.id} - ${api.name}`);
        const testResult = await generateIptvTest(api.id - 1);
        if (testResult.success) {
          aiResponse = testResult.message;
        } else {
          // Fallback: tenta outros servidores
          let fallbackResult = null;
          for (let i = 0; i < IPTV_APIS.length; i++) {
            if (i === api.id - 1) continue;
            fallbackResult = await generateIptvTest(i);
            if (fallbackResult.success) break;
          }
          if (fallbackResult && fallbackResult.success) {
            aiResponse = `⚠️ O servidor escolhido não respondeu, mas geramos um teste em outro servidor:\n\n${fallbackResult.message}`;
          } else {
            aiResponse = `❌ Não foi possível gerar teste em nenhum servidor. Tente novamente.`;
          }
        }
      } else {
        aiResponse = `❌ Número inválido. Digite *APIS* para ver a lista de servidores disponíveis.`;
      }
    }

    // ==========================================
    // 3. PALAVRAS DE TESTE (sem número)
    // ==========================================
    else if (lowerMsg.includes('teste') || lowerMsg.includes('experimentar') || lowerMsg.includes('gratis') || lowerMsg.includes('grátis') || lowerMsg.includes('quero testar') || lowerMsg.includes('gerar')) {
      let apiList = `📡 *ESCOLHA O SERVIDOR PARA SEU TESTE - VS SOLUÇÕES*\n\n`;
      IPTV_APIS.forEach(api => {
        apiList += `${api.id}. ${api.name}\n`;
      });
      apiList += `\n💡 Digite o *número* correspondente para gerar seu teste imediatamente.`;
      aiResponse = apiList;
    }

    // ==========================================
    // 4. PLANOS
    // ==========================================
    else if (lowerMsg.includes('plano') || lowerMsg.includes('planos') || lowerMsg.includes('preço') || lowerMsg.includes('valor') || lowerMsg.includes('quanto custa') || lowerMsg.includes('preços')) {
      const plans = await getIptvPlans();
      if (plans) {
        aiResponse = plans;
      } else {
        aiResponse = `📺 *Planos IPTV - VS SOLUÇÕES*\n\nTemos planos a partir de R$ 19,90/mês com mais de 2000 canais.\n\n💳 *Formas de pagamento:*\n• Pix\n• Cartão de crédito\n• Boleto\n\n📡 *Benefícios:*\n✅ Canais em HD/4K\n✅ Sem travamentos\n✅ Suporte 24/7\n✅ Compatível com todos os dispositivos\n\n📱 *Dispositivos:* Smart TV, Android, iOS, Firestick, PC e mais!\n\n💡 Para testar, digite *APIS* para ver os servidores.`;
      }
    }

    // ==========================================
    // 5. SITE / DOWNLOAD
    // ==========================================
    else if (lowerMsg.includes('site') || lowerMsg.includes('download') || lowerMsg.includes('aplicativo') || lowerMsg.includes('app') || lowerMsg.includes('baixar')) {
      aiResponse = `📲 *VS SOLUÇÕES - Aplicativos e Downloads*\n\n📱 *Android:*\n• MultServer MAX - Código Downloader: 6469569\n• App: http://aftv.news/6469569\n\n📱 *MultServer PLUS:*\n• Código Downloader: 2572490\n• App: http://aftv.news/2572490\n\n📱 *Assist Plus / PlaySim:*\n• Código Downloader: 9465043\n\n📱 *VIZZION PLAY:*\n• Código Downloader: 5338196\n\n📱 *IPTV Smarters:*\n• Disponível nas lojas oficiais\n\n🛒 *Loja de Aplicativos:* https://bit.ly/lojaolympus\n\n💡 Digite *APIS* para escolher um servidor e testar!`;
    }

    // ==========================================
    // 6. IA GENERATIVA (outras perguntas)
    // ==========================================
    else {
      const history = await getConversationHistory(senderName, groupName, isMessageFromGroup, 6);

      const messages = [
        {
          role: "system",
          content: `Você é uma assistente especializada em IPTV da VS SOLUÇÕES. Você ajuda clientes a entenderem os benefícios da TV online, tira dúvidas sobre planos, canais, compatibilidade e configuração.

          REGRAS IMPORTANTES:
          1. Se o cliente pedir TESTE, você deve orientá-lo a digitar "APIS" para ver os servidores e depois digitar o número correspondente.
          2. Se perguntar sobre PLANOS, informe os planos disponíveis e destaque os benefícios.
          3. Se perguntar sobre SERVIDORES, liste todos com os números.
          4. Seja educado, rápido, objetivo e use emojis.
          5. Responda em português do Brasil.
          6. Sempre incentive o cliente a experimentar o serviço.
          7. Destaque que a VS SOLUÇÕES oferece qualidade e estabilidade.
          8. Mencione que temos mais de 2000 canais, filmes e séries.

          DATA ATUAL: ${currentDateTime.full}`
        }
      ];

      history.forEach(conv => {
        messages.push({ role: "user", content: conv.sender_message });
        messages.push({ role: "assistant", content: conv.ai_response });
      });

      messages.push({ role: "user", content: senderMessage });

      const response = await callAIWithFallback(messages);
      aiResponse = response.choices[0].message.content;
    }

    // Salva a conversa
    const savedId = await saveConversation({
      senderName,
      groupName,
      isMessageFromGroup,
      senderMessage,
      aiResponse,
      messageDateTime,
      receiveMessageApp
    });

    if (savedId) {
      await cleanupOldMessages(senderName, groupName, isMessageFromGroup);
    }

    console.log(`✅ Resposta gerada: ${aiResponse.substring(0, 100)}...`);

    res.json({
      data: [{ message: aiResponse }]
    });

  } catch (error) {
    console.error('❌ Erro no webhook:', error);
    res.json({
      data: [{ message: "Desculpe, ocorreu um erro. Tente novamente." }]
    });
  }
});

// ============================================
// 8. ROTAS ADMINISTRATIVAS
// ============================================
app.get('/status', async (req, res) => {
  let dbStatus = 'disabled';
  if (mysqlEnabled && pool) {
    try {
      await pool.execute('SELECT 1');
      dbStatus = 'connected';
    } catch (error) {
      dbStatus = 'error';
    }
  }
  res.json({
    status: 'OK',
    service: 'VS SOLUÇÕES - Bot IPTV',
    database: dbStatus,
    mysqlEnabled: mysqlEnabled,
    apis: { total: API_KEYS.length, current: currentApiIndex },
    iptv_apis: IPTV_APIS.map(api => ({ id: api.id, name: api.name })),
    model: model,
    currentDateTime: getCurrentDateTime()
  });
});

app.get('/ping', async (req, res) => {
  let mysqlAlive = false;
  if (mysqlEnabled && pool) {
    try {
      await pool.execute('SELECT 1');
      mysqlAlive = true;
    } catch (error) {}
  }
  res.json({
    status: 'OK',
    service: 'VS SOLUÇÕES - Bot IPTV',
    mysql: mysqlEnabled ? (mysqlAlive ? 'connected' : 'error') : 'disabled',
    iptv_apis: IPTV_APIS.length,
    timestamp: new Date().toISOString()
  });
});

app.get('/', (req, res) => {
  res.json({
    service: 'VS SOLUÇÕES - Bot IPTV com Gerador de Testes',
    status: 'Online',
    company: 'VS SOLUÇÕES',
    mysql: mysqlEnabled ? 'CONECTADO' : 'DESCONECTADO',
    iptv_apis: IPTV_APIS.length,
    endpoints: {
      webhook: 'POST /webhook',
      status: 'GET /status',
      ping: 'GET /ping'
    },
    commands: {
      'APIS': 'Lista todos os servidores com números',
      '[NÚMERO]': 'Gera teste no servidor correspondente (ex: 2)',
      'PLANOS': 'Mostra os planos disponíveis',
      'SITE / DOWNLOAD': 'Informações sobre aplicativos e downloads'
    },
    available_apis: IPTV_APIS.map(api => ({ id: api.id, name: api.name }))
  });
});

app.get('/apis', (req, res) => {
  res.json({
    service: 'VS SOLUÇÕES',
    apis: IPTV_APIS.map(api => ({
      id: api.id,
      name: api.name,
      url: api.url
    }))
  });
});

// ============================================
// 9. INICIALIZAÇÃO
// ============================================
async function startServer() {
  console.log('🚀 Iniciando VS SOLUÇÕES - Bot IPTV com Gerador de Testes...');
  console.log(`🔑 ${API_KEYS.length} chaves IA configuradas`);
  console.log(`📡 ${IPTV_APIS.length} servidores de teste IPTV configurados:`);
  IPTV_APIS.forEach(api => {
    console.log(`   ${api.id}. ${api.name}`);
  });

  await initializeDatabase();

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`🎉 Servidor rodando na porta ${PORT}`);
    console.log(`🌐 Webhook: POST /webhook`);
    console.log(`🗃️  MySQL: ${mysqlEnabled ? '✅ CONECTADO' : '❌ DESCONECTADO'}`);
    console.log(`📅 Data/Hora: ${getCurrentDateTime().full}`);
    console.log(`\n🏢 VS SOLUÇÕES - Qualidade e estabilidade em IPTV`);
    console.log(`📡 Comandos disponíveis:`);
    console.log(`   • APIS - Lista servidores com números`);
    console.log(`   • [NÚMERO] - Gera teste (ex: 2)`);
    console.log(`   • PLANOS - Mostra planos`);
    console.log(`   • SITE/DOWNLOAD - Informações de apps`);
  });
}

startServer().catch(console.error);
