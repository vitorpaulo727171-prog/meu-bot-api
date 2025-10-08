const express = require('express');
const OpenAI = require('openai');
const mysql = require('mysql2/promise');

const app = express();
app.use(express.json());

// Configurações das APIs - múltiplas chaves
const API_KEYS = [
  process.env.GITHUB_TOKEN_1,  // Sua primeira chave (tem acesso ao gpt-4.1)
  process.env.GITHUB_TOKEN_2,  // Sua segunda chave
  // Adicione mais chaves conforme necessário
].filter(Boolean); // Remove chaves vazias

const endpoint = "https://models.github.ai/inference";

// Lista de modelos em ordem de preferência
const MODEL_PREFERENCES = [
  'openai/gpt-4.1',      // Modelo premium
  'openai/gpt-4',        // GPT-4 padrão
  'openai/gpt-4o',       // GPT-4 Omni
  'openai/gpt-3.5-turbo', // GPT-3.5 (mais amplamente disponível)
  'openai/gpt-3.5-turbo-16k'
];

// Sistema de rotacionamento de APIs e modelos
let currentApiIndex = 0;
let currentModelIndex = 0;
let rateLimitStats = {};
let modelAccessStats = {};

// String de conexão direta do Railway
const MYSQL_CONNECTION_STRING = "mysql://root:ZefFlJwoGgbGclwcSyOeZuvMGVqmhvtH@trolley.proxy.rlwy.net:52398/railway";

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
  console.error("Configure GITHUB_TOKEN_1, GITHUB_TOKEN_2, etc.");
  process.exit(1);
}

console.log(`🔑 ${API_KEYS.length} chaves API configuradas`);
console.log(`🤖 ${MODEL_PREFERENCES.length} modelos disponíveis para fallback`);

// Função para obter o cliente atual
function getCurrentClient() {
  const token = API_KEYS[currentApiIndex];
  return new OpenAI({
    baseURL: endpoint,
    apiKey: token
  });
}

// Função para obter o modelo atual
function getCurrentModel() {
  return MODEL_PREFERENCES[currentModelIndex];
}

// Função para rotacionar para a próxima API
function rotateToNextApi() {
  const oldIndex = currentApiIndex;
  currentApiIndex = (currentApiIndex + 1) % API_KEYS.length;
  
  // Resetar o modelo para o preferido quando mudar de API
  currentModelIndex = 0;
  
  // Registrar o rate limit na API antiga
  if (!rateLimitStats[oldIndex]) {
    rateLimitStats[oldIndex] = { rateLimitedAt: new Date() };
  } else {
    rateLimitStats[oldIndex].rateLimitedAt = new Date();
  }
  
  console.log(`🔄 Rotacionando API: ${oldIndex} → ${currentApiIndex}`);
  console.log(`📊 Estatísticas: ${Object.keys(rateLimitStats).length} APIs com rate limit`);
  
  return getCurrentClient();
}

// Função para rotacionar para o próximo modelo
function rotateToNextModel() {
  const oldModel = getCurrentModel();
  currentModelIndex = (currentModelIndex + 1) % MODEL_PREFERENCES.length;
  const newModel = getCurrentModel();
  
  // Registrar o modelo sem acesso
  const modelKey = `${currentApiIndex}_${oldModel}`;
  modelAccessStats[modelKey] = { noAccessAt: new Date() };
  
  console.log(`🔄 Rotacionando Modelo: ${oldModel} → ${newModel}`);
  console.log(`📊 Estatísticas: ${Object.keys(modelAccessStats).length} combinações API/Modelo sem acesso`);
  
  return getCurrentModel();
}

// Função para fazer chamada à API com tratamento de rate limit e acesso a modelos
async function callAIWithFallback(messages, maxRetries = API_KEYS.length * MODEL_PREFERENCES.length) {
  let lastError;
  let attempts = 0;
  
  while (attempts < maxRetries) {
    const client = getCurrentClient();
    const model = getCurrentModel();
    const currentTokenIndex = currentApiIndex;
    const currentModelName = model;
    
    try {
      console.log(`🤖 Tentando API ${currentTokenIndex} com modelo ${currentModelName} (tentativa ${attempts + 1}/${maxRetries})`);
      
      const response = await client.chat.completions.create({
        messages: messages,
        temperature: 0.7,
        top_p: 1.0,
        model: model
      });
      
      console.log(`✅ Sucesso com API ${currentTokenIndex} e modelo ${currentModelName}`);
      return response;
      
    } catch (error) {
      lastError = error;
      attempts++;
      
      // Verificar se é rate limit
      if (error.code === 'RateLimitReached' || error.message?.includes('Rate limit')) {
        console.log(`⏰ Rate limit na API ${currentTokenIndex}: ${error.message}`);
        
        // Rotacionar para próxima API
        rotateToNextApi();
        
      } 
      // Verificar se é acesso negado ao modelo
      else if (error.code === 'no_access' || error.message?.includes('No access to model')) {
        console.log(`🚫 Acesso negado ao modelo ${currentModelName} na API ${currentTokenIndex}`);
        
        // Tentar próximo modelo
        if (currentModelIndex < MODEL_PREFERENCES.length - 1) {
          rotateToNextModel();
        } else {
          // Se não há mais modelos, rotacionar API
          rotateToNextApi();
        }
        
      } else {
        // Outro tipo de erro
        console.error(`❌ Erro na API ${currentTokenIndex} com modelo ${currentModelName}:`, error.message);
        
        // Tentar próxima combinação
        if (currentModelIndex < MODEL_PREFERENCES.length - 1) {
          rotateToNextModel();
        } else {
          rotateToNextApi();
        }
      }
      
      // Pequena pausa antes da próxima tentativa
      if (attempts < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
  }
  
  // Se chegou aqui, todas as combinações falharam
  throw lastError || new Error('Todas as APIs e modelos falharam');
}

// Pool de conexões MySQL
let pool;
let mysqlEnabled = false;

// [AS FUNÇÕES DE BANCO DE DADOS PERMANECEM EXATAMENTE AS MESMAS...]
// initializeDatabase, testMySQLConnection, generateSessionId, saveConversation, 
// getConversationHistory, cleanupOldMessages - todas idênticas ao código anterior

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
    
    const testSessionId = 'test_session_' + Date.now();
    const [insertResult] = await connection.execute(
      `INSERT INTO conversations (session_id, sender_name, sender_message, ai_response) VALUES (?, ?, ?, ?)`,
      [testSessionId, 'test_user', 'Test message', 'Test response']
    );
    
    const [selectResult] = await connection.execute(
      `SELECT * FROM conversations WHERE id = ?`,
      [insertResult.insertId]
    );
    
    if (selectResult.length > 0) {
      console.log('✅ Teste de inserção/leitura: OK');
      await connection.execute(`DELETE FROM conversations WHERE id = ?`, [insertResult.insertId]);
    }
    
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
      } catch (e) {}
    }
  }
}

async function testMySQLConnection() {
  console.log('🔌 Testando conexão MySQL...');
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

function generateSessionId(senderName, groupName, isMessageFromGroup) {
  if (isMessageFromGroup && groupName) {
    return `group_${groupName}_user_${senderName}`;
  }
  return `user_${senderName}`;
}

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
    console.log(`🔑 API atual: ${currentApiIndex}, Modelo: ${getCurrentModel()}`);

    // Busca histórico recente da conversa
    const history = await getConversationHistory(senderName, groupName, isMessageFromGroup, 6);
    
    // Prepara o contexto com histórico
    const messages = [
      {
        role: "system",
        content: `Você é um assistente útil e amigável. Responda de forma natural, concisa e em português.
        Mantenha o contexto da conversa anterior. Seja breve mas prestativo.
        ${groupName ? `Estamos no grupo "${groupName}".` : `Conversando com ${senderName}.`}
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

    // Processa a mensagem com a IA (com fallback para múltiplas APIs e modelos)
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
    } else if (error.code === 'no_access' || error.message?.includes('No access to model')) {
      errorMessage = "Desculpe, estou com problemas de acesso aos meus recursos no momento. Tente novamente em alguns instantes!";
    }
    
    res.json({
      data: [{
        message: errorMessage
      }]
    });
  }
});

// Rotas administrativas (mantidas do código anterior)
app.get('/conversations', async (req, res) => {
  if (!mysqlEnabled || !pool) {
    return res.status(500).json({ error: 'MySQL não disponível' });
  }
  try {
    const [rows] = await pool.execute(`SELECT * FROM conversations ORDER BY created_at DESC LIMIT 50`);
    res.json({ status: 'success', count: rows.length, data: rows });
  } catch (error) {
    console.error('Erro ao buscar conversas:', error);
    res.status(500).json({ error: 'Erro interno do servidor', message: error.message });
  }
});

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
      current_api: currentApiIndex,
      current_model: getCurrentModel(),
      apis: {
        total: API_KEYS.length,
        statistics: apiStats
      },
      models: {
        preferences: MODEL_PREFERENCES,
        current_index: currentModelIndex
      },
      model_access_stats: modelAccessStats,
      timestamp: new Date().toISOString(),
      uptime: Math.floor(process.uptime()) + ' segundos'
    });
  } catch (error) {
    res.status(500).json({ status: 'Error', message: 'Service unhealthy' });
  }
});

app.post('/rotate-api', (req, res) => {
  const oldIndex = currentApiIndex;
  rotateToNextApi();
  res.json({
    message: 'API rotacionada',
    from: oldIndex,
    to: currentApiIndex,
    current_model: getCurrentModel(),
    total_apis: API_KEYS.length
  });
});

app.post('/rotate-model', (req, res) => {
  const oldModel = getCurrentModel();
  rotateToNextModel();
  res.json({
    message: 'Modelo rotacionado',
    from: oldModel,
    to: getCurrentModel(),
    current_api: currentApiIndex
  });
});

app.get('/ping', (req, res) => {
  res.status(200).json({
    status: 'OK',
    mysql: mysqlEnabled ? 'connected' : 'disabled',
    apis: { total: API_KEYS.length, current: currentApiIndex },
    model: getCurrentModel(),
    timestamp: new Date().toISOString()
  });
});

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
      apis: { total: API_KEYS.length, current: currentApiIndex },
      model: getCurrentModel(),
      timestamp: new Date().toISOString(),
      uptime: Math.floor(process.uptime()) + ' segundos'
    });
  } catch (error) {
    res.status(500).json({ status: 'Error', message: 'Service unhealthy' });
  }
});

app.get('/', (req, res) => {
  res.json({ 
    service: 'AutoReply Webhook com Multi-API + Multi-Model',
    status: 'Online',
    mysql: mysqlEnabled ? 'CONECTADO' : 'DESCONECTADO',
    current_api: currentApiIndex,
    current_model: getCurrentModel(),
    deployment: 'Railway',
    endpoints: {
      webhook: 'POST /webhook',
      health: 'GET /health',
      status: 'GET /status',
      ping: 'GET /ping',
      'rotate-api': 'POST /rotate-api',
      'rotate-model': 'POST /rotate-model',
      conversations: 'GET /conversations (admin)'
    }
  });
});

// Inicializa o servidor
async function startServer() {
  console.log('🚀 Iniciando servidor AutoReply com Multi-API e Multi-Model...');
  console.log(`🔑 ${API_KEYS.length} chaves API configuradas`);
  console.log(`🤖 Modelos disponíveis: ${MODEL_PREFERENCES.join(', ')}`);
  
  await initializeDatabase();
  
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`🎉 Servidor rodando na porta ${PORT}`);
    console.log(`🌐 Webhook: POST /webhook`);
    console.log(`🔍 Status: GET /status`);
    console.log(`🔄 Rotacionar API: POST /rotate-api`);
    console.log(`🔄 Rotacionar Modelo: POST /rotate-model`);
    console.log(`🗃️  MySQL: ${mysqlEnabled ? '✅ CONECTADO' : '❌ DESCONECTADO'}`);
    
    console.log('\n🎯 SISTEMA MULTI-API/MULTI-MODEL CONFIGURADO:');
    console.log(`   ✅ ${API_KEYS.length} chaves disponíveis`);
    console.log(`   ✅ ${MODEL_PREFERENCES.length} modelos para fallback`);
    console.log(`   ✅ Rotacionamento automático em rate limit`);
    console.log(`   ✅ Fallback automático para modelos disponíveis`);
    console.log(`   ✅ Estatísticas de uso e acesso`);
    
    if (mysqlEnabled) {
      console.log('\n💬 Pronto para receber mensagens com histórico de contexto!');
    }
  });
}

startServer().catch(console.error);
