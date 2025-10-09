const express = require('express');
const OpenAI = require('openai');
const mysql = require('mysql2/promise');
const https = require('https');
const http = require('http');

const app = express();
app.use(express.json());

// Configurações das APIs - múltiplas chaves
const API_KEYS = [
  process.env.GITHUB_TOKEN_1,
  process.env.GITHUB_TOKEN_2,
  process.env.GITHUB_TOKEN_3,
  process.env.GITHUB_TOKEN_4,
].filter(Boolean);

const endpoint = "https://models.github.ai/inference";
const model = "openai/gpt-4.1";

// URL do seu PHP no InfinityFree - CONFIGURE ESTA URL!
const PROMPT_API_URL = process.env.PROMPT_API_URL || 'https://seu-site.infinityfree.com/api.php';
const PROMPT_API_TOKEN = process.env.PROMPT_API_TOKEN || 'SEU_TOKEN_SECRETO';

// Sistema de rotacionamento de APIs
let currentApiIndex = 0;
let rateLimitStats = {};

// String de conexão direta do Railway
const MYSQL_CONNECTION_STRING = process.env.MYSQL_CONNECTION_STRING || "mysql://root:ZefFlJwoGgbGclwcSyOeZuvMGVqmhvtH@trolley.proxy.rlwy.net:52398/railway";

// Parse da string de conexão
function parseMySQLString(connectionString) {
  try {
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
  } catch (error) {
    console.error('❌ Erro ao parsear string MySQL:', error);
  }
  return null;
}

// Configurações do MySQL
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

// Verifica se há pelo menos uma chave API disponível
if (API_KEYS.length === 0) {
  console.error("ERRO: Nenhuma GITHUB_TOKEN encontrada nas variáveis de ambiente");
  process.exit(1);
}

console.log(`🔑 ${API_KEYS.length} chaves API configuradas`);

// Função para obter o cliente atual
function getCurrentClient() {
  const token = API_KEYS[currentApiIndex];
  return new OpenAI({
    baseURL: endpoint,
    apiKey: token
  });
}

// Função para rotacionar para a próxima API
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

// Função para carregar prompt do PHP
async function loadPromptFromPHP() {
  return new Promise((resolve, reject) => {
    const url = `${PROMPT_API_URL}?token=${PROMPT_API_TOKEN}`;
    const urlObj = new URL(url);
    const protocol = urlObj.protocol === 'https:' ? https : http;
    
    console.log(`🌐 Buscando prompt de: ${urlObj.host}`);
    
    const req = protocol.get(url, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
        return;
      }

      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        console.log('✅ Prompt carregado do PHP');
        resolve(data);
      });
    });

    req.on('error', (error) => {
      console.error('❌ Erro ao carregar prompt do PHP:', error.message);
      reject(error);
    });

    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error('Timeout ao carregar prompt (10s)'));
    });
  });
}

// Prompt padrão de fallback
const defaultPrompt = `Você é um atendente da loja "Mercado dos Sabores". Seja prestativo, educado e objetivo.

INFORMAÇÕES GERAIS:
• Endereço: Rua Raimundo Lemos Dias, 68 - Luciano Cavalcante, Fortaleza-CE
• Pagamento: PIX e Dinheiro
• Site: https://lojams.rf.gd 
• Retirada no local ou via UberFlash (custo por conta do cliente)

CATÁLOGO DE PRODUTOS:

🎂 BROWNIES (R$ 4,00 cada):
• Brownie Ferrero - Brigadeiro 50% cacau, creme de avelã e amendoim
• Brownie Doce de Leite - Recheio cremoso de doce de leite
• Brownie Ninho - Recheio cremoso de leite Ninho
• Brownie Paçoca - Recheio cremoso de paçoca
• Brownie Pistache - Casquinha crocante, interior molhadinho
• Brownie Brigadeiro - Tradicional brigadeiro

INSTRUÇÕES PARA ATENDIMENTO:
1. Sempre informe preço e disponibilidade ao mencionar produtos
2. Para itens indisponíveis, sugira alternativas similares
3. Destaque promoções e descontos
4. Direcione para o site para ver fotos e fazer pedidos
5. Seja claro sobre condições de pagamento e retirada
6. Mantenha respostas curtas e objetivas
7. Use emojis para deixar a comunicação mais amigável
8. Considere o histórico da conversa para dar respostas contextuais`;

// Variável para armazenar o prompt atual
let currentPrompt = defaultPrompt;
let lastPromptUpdate = null;
let promptErrorCount = 0;

// Função para inicializar e atualizar o prompt
async function updatePrompt() {
  try {
    const newPrompt = await loadPromptFromPHP();
    if (newPrompt && newPrompt.trim().length > 0) {
      currentPrompt = newPrompt;
      lastPromptUpdate = new Date();
      promptErrorCount = 0;
      console.log(`📝 Prompt atualizado - ${currentPrompt.length} caracteres`);
    } else {
      throw new Error('Prompt vazio retornado do servidor');
    }
  } catch (error) {
    promptErrorCount++;
    console.error(`❌ Erro ao atualizar prompt (tentativa ${promptErrorCount}):`, error.message);
    
    // Se houver muitos erros consecutivos, usar prompt padrão
    if (promptErrorCount >= 3) {
      console.log('🔄 Usando prompt padrão devido a erros consecutivos');
      currentPrompt = defaultPrompt;
    }
  }
}

// Função para fazer chamada à API com tratamento de rate limit
async function callAIWithFallback(messages, maxRetries = API_KEYS.length) {
  let lastError;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const client = getCurrentClient();
    const currentTokenIndex = currentApiIndex;
    
    try {
      console.log(`🤖 Tentando API ${currentTokenIndex} (tentativa ${attempt + 1}/${maxRetries})`);
      
      const response = await client.chat.completions.create({
        messages: messages,
        temperature: 0.7,
        top_p: 1.0,
        model: model
      });
      
      console.log(`✅ Sucesso com API ${currentTokenIndex}`);
      return response;
      
    } catch (error) {
      lastError = error;
      
      if (error.code === 'RateLimitReached' || error.message?.includes('Rate limit')) {
        console.log(`⏰ Rate limit na API ${currentTokenIndex}: ${error.message}`);
        rotateToNextApi();
        
        if (attempt < maxRetries - 1) {
          console.log(`🔄 Tentando próxima API...`);
          continue;
        }
      } else {
        console.error(`❌ Erro na API ${currentTokenIndex}:`, error.message);
        
        if (attempt < maxRetries - 1) {
          console.log(`🔄 Tentando próxima API devido a erro...`);
          rotateToNextApi();
          continue;
        }
      }
    }
  }
  
  throw lastError || new Error('Todas as APIs falharam');
}

// Pool de conexões MySQL
let pool;
let mysqlEnabled = false;

// Função para testar conexão MySQL
async function testMySQLConnection() {
  console.log('🔌 Testando conexão MySQL...');
  console.log(`   Host: ${dbConfig.host}`);
  console.log(`   Database: ${dbConfig.database}`);
  
  try {
    const testConnection = await mysql.createConnection(dbConfig);
    await testConnection.execute('SELECT 1 as test');
    console.log('✅ Teste de conexão MySQL: OK');
    await testConnection.end();
    return true;
  } catch (error) {
    console.error('❌ Teste de conexão MySQL falhou:', error.message);
    return false;
  }
}

async function initializeDatabase() {
  console.log('🔄 Inicializando MySQL para Railway...');
  
  if (!dbConfig.host || !dbConfig.user || !dbConfig.password || !dbConfig.database) {
    console.log('🚫 Configurações do MySQL incompletas');
    mysqlEnabled = false;
    return;
  }

  const connectionTest = await testMySQLConnection();
  if (!connectionTest) {
    console.log('🚫 MySQL desabilitado - não foi possível conectar');
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
    console.log('✅ Pool MySQL conectado com sucesso');
    
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
    console.log('✅ Tabela conversations verificada/criada');
    
    connection.release();
    mysqlEnabled = true;
    console.log('🎉 MySQL totalmente inicializado e funcionando!');
    
  } catch (error) {
    console.error('❌ Erro na inicialização do MySQL:', error.message);
    mysqlEnabled = false;
    
    if (pool) {
      try {
        await pool.end();
        pool = null;
      } catch (e) {
        console.error('Erro ao fechar pool:', e.message);
      }
    }
  }
}

// Função para gerar session_id
function generateSessionId(senderName, groupName, isMessageFromGroup) {
  if (isMessageFromGroup && groupName) {
    return `group_${groupName}_user_${senderName}`;
  }
  return `user_${senderName}`;
}

// Função para salvar conversa no banco
async function saveConversation(conversationData) {
  if (!mysqlEnabled || !pool) {
    console.log('⚠️  MySQL não disponível, pulando salvamento');
    return null;
  }

  try {
    const sessionId = generateSessionId(
      conversationData.senderName,
      conversationData.groupName,
      conversationData.isMessageFromGroup
    );

    console.log(`💾 Salvando conversa para: ${sessionId}`);
    
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
    
    console.log(`✅ Conversa salva - ID: ${result.insertId}`);
    return result.insertId;
    
  } catch (error) {
    console.error('❌ Erro ao salvar conversa:', error.message);
    return null;
  }
}

// Função para buscar histórico de conversas
async function getConversationHistory(senderName, groupName, isMessageFromGroup, limit = 6) {
  if (!mysqlEnabled || !pool) {
    console.log('⚠️  MySQL não disponível, sem histórico');
    return [];
  }

  try {
    const sessionId = generateSessionId(senderName, groupName, isMessageFromGroup);
    
    console.log(`📚 Buscando histórico para sessão: ${sessionId}`);
    
    const safeLimit = parseInt(limit);
    const [rows] = await pool.execute(
      `SELECT sender_message, ai_response, created_at 
       FROM conversations 
       WHERE session_id = ? 
       ORDER BY created_at DESC 
       LIMIT ${safeLimit}`,
      [sessionId]
    );
    
    console.log(`✅ Histórico carregado: ${rows.length} mensagens`);
    return rows.reverse();
    
  } catch (error) {
    console.error('❌ Erro ao buscar histórico:', error.message);
    return [];
  }
}

// Função para limpar histórico antigo
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
      
      console.log(`🧹 Mensagens antigas limpas para: ${sessionId}`);
    }
  } catch (error) {
    console.error('❌ Erro ao limpar mensagens antigas:', error.message);
  }
}

// Webhook principal
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

    console.log(`📩 Mensagem de ${senderName}${groupName ? ` no grupo ${groupName}` : ''}: ${senderMessage}`);
    console.log(`🗃️  MySQL: ${mysqlEnabled ? 'HABILITADO' : 'DESABILITADO'}`);
    console.log(`🔑 API atual: ${currentApiIndex}`);
    console.log(`📝 Prompt: ${currentPrompt.length} caracteres (atualizado: ${lastPromptUpdate ? lastPromptUpdate.toLocaleTimeString() : 'NUNCA'})`);

    // Busca histórico recente da conversa
    const history = await getConversationHistory(senderName, groupName, isMessageFromGroup, 6);
    
    // Prepara o contexto com histórico e prompt dinâmico
    const messages = [
      {
        role: "system",
        content: currentPrompt + `\n\n${groupName ? `Estamos no grupo "${groupName}".` : `Conversando com ${senderName}.`}
        ${history.length > 0 ? `Esta conversa tem ${history.length} mensagens de histórico.` : ''}`
      }
    ];

    // Adiciona histórico ao contexto
    history.forEach(conv => {
      messages.push({ role: "user", content: conv.sender_message });
      messages.push({ role: "assistant", content: conv.ai_response });
    });

    // Adiciona a mensagem atual
    messages.push({ role: "user", content: senderMessage });

    console.log(`🤖 Processando com ${messages.length} mensagens de contexto (${history.length} do histórico)`);

    // Processa a mensagem com a IA
    const response = await callAIWithFallback(messages);

    const aiResponse = response.choices[0].message.content;

    // Salva a conversa no banco
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

    console.log(`✅ Resposta gerada (MySQL: ${savedId ? 'SALVO' : 'NÃO SALVO'}): ${aiResponse.substring(0, 100)}...`);

    // Retorna a resposta
    res.json({
      data: [{
        message: aiResponse
      }]
    });

  } catch (error) {
    console.error('❌ Erro ao processar mensagem:', error);
    
    let errorMessage = "Desculpe, estou tendo problemas técnicos. Tente novamente!";
    
    if (error.code === 'RateLimitReached' || error.message?.includes('Rate limit')) {
      errorMessage = "Desculpe, atingi meu limite de uso por hoje. Por favor, tente novamente amanhã!";
    }
    
    res.json({
      data: [{
        message: errorMessage
      }]
    });
  }
});

// Rota para visualizar conversas
app.get('/conversations', async (req, res) => {
  if (!mysqlEnabled || !pool) {
    return res.status(500).json({ 
      error: 'MySQL não disponível',
      mysqlEnabled: mysqlEnabled
    });
  }

  try {
    const [rows] = await pool.execute(
      `SELECT * FROM conversations ORDER BY created_at DESC LIMIT 50`
    );
    res.json({
      status: 'success',
      count: rows.length,
      data: rows
    });
  } catch (error) {
    console.error('Erro ao buscar conversas:', error);
    res.status(500).json({ 
      error: 'Erro interno do servidor',
      message: error.message
    });
  }
});

// Rota para status do banco, APIs e prompt
app.get('/status', async (req, res) => {
  try {
    let dbStatus = 'disabled';
    if (mysqlEnabled && pool) {
      try {
        await pool.execute('SELECT 1');
        dbStatus = 'connected';
      } catch (error) {
        dbStatus = 'error';
      }
    }

    // Estatísticas das APIs
    const apiStats = API_KEYS.map((_, index) => ({
      index,
      isCurrent: index === currentApiIndex,
      rateLimited: rateLimitStats[index] ? true : false,
      rateLimitedAt: rateLimitStats[index]?.rateLimitedAt || null
    }));

    res.json({ 
      status: 'OK', 
      database: dbStatus,
      mysqlEnabled: mysqlEnabled,
      prompt: {
        length: currentPrompt.length,
        lastUpdate: lastPromptUpdate,
        source: 'PHP API',
        errorCount: promptErrorCount
      },
      apis: {
        total: API_KEYS.length,
        current: currentApiIndex,
        statistics: apiStats
      },
      model: model,
      timestamp: new Date().toISOString(),
      uptime: Math.floor(process.uptime()) + ' segundos'
    });
  } catch (error) {
    res.status(500).json({ 
      status: 'Error', 
      message: 'Service unhealthy'
    });
  }
});

// Rota para forçar atualização do prompt
app.post('/reload-prompt', async (req, res) => {
  try {
    await updatePrompt();
    res.json({
      success: true,
      message: 'Prompt recarregado',
      promptLength: currentPrompt.length,
      lastUpdate: lastPromptUpdate
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Rota para ver o prompt atual
app.get('/current-prompt', (req, res) => {
  res.json({
    prompt: currentPrompt,
    length: currentPrompt.length,
    lastUpdate: lastPromptUpdate
  });
});

// Rota para forçar rotação de API
app.post('/rotate-api', (req, res) => {
  const oldIndex = currentApiIndex;
  rotateToNextApi();
  
  res.json({
    message: 'API rotacionada',
    from: oldIndex,
    to: currentApiIndex,
    total_apis: API_KEYS.length
  });
});

// Rota específica para uptime monitoring
app.get('/ping', (req, res) => {
  res.status(200).json({
    status: 'OK',
    mysql: mysqlEnabled ? 'connected' : 'disabled',
    prompt: {
      loaded: currentPrompt.length > 0,
      length: currentPrompt.length
    },
    apis: {
      total: API_KEYS.length,
      current: currentApiIndex
    },
    model: model,
    timestamp: new Date().toISOString(),
    service: 'Railway MySQL + Multi-API + Dynamic Prompt'
  });
});

// Rota de health check
app.get('/health', async (req, res) => {
  try {
    let dbStatus = 'disabled';
    if (mysqlEnabled && pool) {
      try {
        await pool.execute('SELECT 1');
        dbStatus = 'connected';
      } catch (error) {
        dbStatus = 'error';
      }
    }

    res.status(200).json({ 
      status: 'OK', 
      database: dbStatus,
      mysqlEnabled: mysqlEnabled,
      prompt: {
        loaded: currentPrompt.length > 0,
        length: currentPrompt.length,
        lastUpdate: lastPromptUpdate
      },
      apis: {
        total: API_KEYS.length,
        current: currentApiIndex
      },
      model: model,
      timestamp: new Date().toISOString(),
      uptime: Math.floor(process.uptime()) + ' segundos'
    });
  } catch (error) {
    res.status(500).json({ 
      status: 'Error', 
      message: 'Service unhealthy'
    });
  }
});

// Rota raiz
app.get('/', (req, res) => {
  res.json({ 
    service: 'AutoReply Webhook com Multi-API + MySQL + Prompt Dinâmico',
    status: 'Online',
    mysql: mysqlEnabled ? 'CONECTADO' : 'DESCONECTADO',
    prompt: {
      loaded: currentPrompt.length > 0,
      length: currentPrompt.length
    },
    apis: {
      total: API_KEYS.length,
      current: currentApiIndex
    },
    model: model,
    deployment: 'Railway + InfinityFree PHP',
    endpoints: {
      webhook: 'POST /webhook',
      health: 'GET /health',
      status: 'GET /status',
      ping: 'GET /ping',
      'reload-prompt': 'POST /reload-prompt',
      'current-prompt': 'GET /current-prompt',
      'rotate-api': 'POST /rotate-api',
      conversations: 'GET /conversations (admin)'
    }
  });
});

// Inicializa o servidor
async function startServer() {
  console.log('🚀 Iniciando servidor AutoReply com Multi-API e Prompt Dinâmico...');
  console.log(`🔑 ${API_KEYS.length} chaves API configuradas`);
  console.log(`🤖 Modelo: ${model}`);
  console.log(`🌐 Prompt URL: ${PROMPT_API_URL}`);
  console.log('🔧 Configurações MySQL:');
  console.log(`   Host: ${dbConfig.host}`);
  console.log(`   Database: ${dbConfig.database}`);
  
  // Inicializar MySQL
  await initializeDatabase();
  
  // Inicializar prompt (aguardar primeiro carregamento)
  console.log('🔄 Carregando prompt inicial do PHP...');
  await updatePrompt();
  
  // Configurar atualização periódica do prompt (a cada 5 minutos)
  setInterval(updatePrompt, 5 * 60 * 1000);
  console.log('⏰ Atualização automática do prompt configurada (5 minutos)');
  
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`🎉 Servidor rodando na porta ${PORT}`);
    console.log(`🌐 Webhook: POST /webhook`);
    console.log(`🔍 Health: GET /health`);
    console.log(`📊 Status completo: GET /status`);
    console.log(`🔄 Recarregar prompt: POST /reload-prompt`);
    console.log(`🗃️  MySQL: ${mysqlEnabled ? '✅ CONECTADO' : '❌ DESCONECTADO'}`);
    console.log(`📝 Prompt: ${currentPrompt.length} caracteres carregados`);
    
    console.log('\n🎯 SISTEMA CONFIGURADO:');
    console.log(`   ✅ ${API_KEYS.length} chaves API`);
    console.log(`   ✅ Prompt dinâmico via PHP`);
    console.log(`   ✅ Rotacionamento automático em rate limit`);
    console.log(`   ✅ Histórico de conversas com MySQL`);
    
    if (mysqlEnabled) {
      console.log('💬 Pronto para receber mensagens com histórico de contexto!');
    }
  });
}

// Tratamento de erros não capturados
process.on('unhandledRejection', (error) => {
  console.error('❌ Erro não tratado:', error);
});

process.on('uncaughtException', (error) => {
  console.error('❌ Exceção não capturada:', error);
  process.exit(1);
});

startServer().catch(console.error);