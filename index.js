const express = require('express');
const OpenAI = require('openai');
const mysql = require('mysql2/promise');
const fetch = require('node-fetch');

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

// Sistema de rotacionamento de APIs
let currentApiIndex = 0;
let rateLimitStats = {};

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

// Função para fazer chamada à API com tratamento de rate limit - COM TEMPERATURE BAIXA
async function callAIWithFallback(messages, maxRetries = API_KEYS.length) {
  let lastError;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const client = getCurrentClient();
    const currentTokenIndex = currentApiIndex;
    
    try {
      console.log(`🤖 Tentando API ${currentTokenIndex} (tentativa ${attempt + 1}/${maxRetries})`);
      
      const response = await client.chat.completions.create({
        messages: messages,
        temperature: 0.3,  // REDUZIDO para maior aderência ao prompt
        top_p: 0.9,        // REDUZIDO para menos criatividade
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
  console.log(`   User: ${dbConfig.user}`);
  console.log(`   Port: ${dbConfig.port}`);
  
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

// Função para gerar messages a partir do PHP - VERSÃO MELHORADA COM LOGS
async function gerarMessages(senderName, groupName, history) {
  try {
    console.log('🌐 Buscando configurações do PHP...');
    const res = await fetch("https://msapp.rf.gd/prompt.php");
    
    if (!res.ok) {
      throw new Error(`HTTP error! status: ${res.status}`);
    }
    
    const config = await res.json();
    
    console.log('✅ Configurações carregadas:', {
      version: config.version,
      role: config.role,
      basePromptLength: config.basePrompt?.length,
      includeUserInfo: config.includeUserInfo,
      includeHistory: config.includeHistory
    });

    let content = config.basePrompt + "\n\n";

    if (config.includeUserInfo) {
      content += groupName ? `Estamos no grupo "${groupName}".\n` : `Conversando com ${senderName}.\n`;
    }

    if (config.includeHistory && history.length > 0) {
      content += `Esta conversa tem ${history.length} mensagens de histórico.\n`;
    }

    if (config.customInstructions) {
      content += config.customInstructions;
    }

    const messages = [{ role: config.role || "system", content: content.trim() }];
    
    console.log("📝 MENSAGEM DO SISTEMA COMPLETA:");
    console.log("═".repeat(50));
    console.log(messages[0].content);
    console.log("═".repeat(50));
    
    return messages;
  } catch (error) {
    console.error('❌ Erro ao carregar configurações do PHP:', error);
    // Fallback ULTRA RESTRITIVO
    const fallbackMessages = [
      {
        role: "system",
        content: `VOCÊ É VENDEDOR DO CURSO DA BUS FINANÇAS. SUA ÚNICA FUNÇÃO É VENDER. 
NUNCA responda outras perguntas. 
NUNCA ofereça ajuda genérica.
SEMPRE venda o curso.
SE falarem de outros assuntos, diga: "Só posso ajudar com a venda do curso financeiro."
${groupName ? `Estamos no grupo "${groupName}".` : `Conversando com ${senderName}.`}
${history.length > 0 ? `Esta conversa tem ${history.length} mensagens de histórico.` : ''}`
      }
    ];
    console.log("⚠️  Usando fallback restritivo");
    return fallbackMessages;
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

// Webhook principal - VERSÃO MELHORADA COM VERIFICAÇÕES
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

    console.log(`📩 Mensagem de ${senderName}${groupName ? ` no grupo ${groupName}` : ''}: "${senderMessage}"`);
    console.log(`🗃️  MySQL: ${mysqlEnabled ? 'HABILITADO' : 'DESABILITADO'}`);
    console.log(`🔑 API atual: ${currentApiIndex}`);

    // Busca histórico recente da conversa
    const history = await getConversationHistory(senderName, groupName, isMessageFromGroup, 6);
    
    // Gera as messages a partir do PHP
    let messages = await gerarMessages(senderName, groupName, history);

    // VERIFICAÇÃO CRÍTICA - Log da primeira message do sistema
    if (messages.length > 0 && messages[0].role === 'system') {
      const systemMessage = messages[0].content;
      const isSalesPrompt = systemMessage.includes('VENDER') || 
                           systemMessage.includes('VENDA') || 
                           systemMessage.includes('CURSO') ||
                           systemMessage.includes('BUS FINANÇAS');
      
      console.log(`🎯 PROMPT DE VENDA: ${isSalesPrompt ? '✅ ATIVADO' : '❌ NÃO DETECTADO'}`);
      
      if (!isSalesPrompt) {
        console.log('🚨 ALERTA: Prompt não parece ser de vendas! Forçando comportamento...');
        // Força o comportamento de vendas
        messages[0].content += "\n\nIMPORTANTE: VOCÊ DEVE VENDER O CURSO FINANCEIRO. NÃO RESPONDA OUTROS ASSUNTOS.";
      }
    }

    // Adiciona histórico ao contexto
    history.forEach(conv => {
      messages.push({ role: "user", content: conv.sender_message });
      messages.push({ role: "assistant", content: conv.ai_response });
    });

    // Adiciona a mensagem atual
    messages.push({ role: "user", content: senderMessage });

    console.log(`🤖 Processando com ${messages.length} mensagens de contexto (${history.length} do histórico)`);

    // LOG FINAL das mensagens que serão enviadas
    console.log('📤 MENSAGENS ENVIADAS PARA IA:');
    messages.forEach((msg, index) => {
      const contentPreview = msg.content.length > 100 ? msg.content.substring(0, 100) + '...' : msg.content;
      console.log(`   [${index}] ${msg.role}: ${contentPreview}`);
    });

    // Processa a mensagem com a IA
    const response = await callAIWithFallback(messages);

    const aiResponse = response.choices[0].message.content;

    // VERIFICAÇÃO DA RESPOSTA
    const isSalesResponse = aiResponse.toLowerCase().includes('curso') || 
                           aiResponse.toLowerCase().includes('venda') || 
                           aiResponse.toLowerCase().includes('financeiro') ||
                           aiResponse.toLowerCase().includes('bus finanças');
    
    console.log(`🎯 RESPOSTA FOI DE VENDA: ${isSalesResponse ? '✅ SIM' : '❌ NÃO'}`);
    
    if (!isSalesResponse) {
      console.log('🚨 RESPOSTA INADEQUADA:', aiResponse);
    }

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

// Rota para testar o prompt atual
app.get('/test-prompt', async (req, res) => {
  try {
    const messages = await gerarMessages("UsuarioTeste", null, []);
    res.json({
      status: 'success',
      systemMessage: messages[0].content,
      length: messages[0].content.length,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Rotas restantes
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

app.get('/ping', (req, res) => {
  res.status(200).json({
    status: 'OK',
    mysql: mysqlEnabled ? 'connected' : 'disabled',
    apis: {
      total: API_KEYS.length,
      current: currentApiIndex
    },
    model: model,
    timestamp: new Date().toISOString(),
    service: 'Railway MySQL + Multi-API'
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

app.get('/', (req, res) => {
  res.json({ 
    service: 'AutoReply Webhook com Multi-API + MySQL',
    status: 'Online',
    mysql: mysqlEnabled ? 'CONECTADO' : 'DESCONECTADO',
    apis: {
      total: API_KEYS.length,
      current: currentApiIndex
    },
    model: model,
    deployment: 'Railway',
    endpoints: {
      webhook: 'POST /webhook',
      health: 'GET /health',
      status: 'GET /status',
      ping: 'GET /ping',
      'rotate-api': 'POST /rotate-api',
      conversations: 'GET /conversations (admin)',
      'test-prompt': 'GET /test-prompt (debug)'
    }
  });
});

// Inicializa o servidor
async function startServer() {
  console.log('🚀 Iniciando servidor AutoReply com Multi-API...');
  console.log(`🔑 ${API_KEYS.length} chaves API configuradas`);
  console.log(`🤖 Modelo: ${model}`);
  console.log('🔧 Configurações MySQL:');
  console.log(`   Host: ${dbConfig.host}`);
  console.log(`   Database: ${dbConfig.database}`);
  console.log(`   User: ${dbConfig.user}`);
  console.log(`   Port: ${dbConfig.port}`);
  
  await initializeDatabase();
  
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`🎉 Servidor rodando na porta ${PORT}`);
    console.log(`🌐 Webhook: POST /webhook`);
    console.log(`🔍 Health: GET /health`);
    console.log(`📊 Status completo: GET /status`);
    console.log(`🔄 Rotacionar API: POST /rotate-api`);
    console.log(`🧪 Testar prompt: GET /test-prompt`);
    console.log(`🗃️  MySQL: ${mysqlEnabled ? '✅ CONECTADO' : '❌ DESCONECTADO'}`);
    
    console.log('\n🎯 SISTEMA MULTI-API CONFIGURADO:');
    console.log(`   ✅ ${API_KEYS.length} chaves disponíveis`);
    console.log(`   ✅ Modelo fixo: ${model}`);
    console.log(`   ✅ Temperature baixa (0.3) para seguir prompt`);
    console.log(`   ✅ Rotacionamento automático em rate limit`);
    console.log(`   ✅ Fallback para próxima API`);
    console.log(`   ✅ Verificação de prompt de vendas`);
    console.log(`   ✅ Logs detalhados para debugging`);
    console.log(`   ✅ Prompt dinâmico via PHP`);
    
    if (mysqlEnabled) {
      console.log('\n💬 Pronto para receber mensagens com histórico de contexto!');
    }

    console.log('\n⚠️  INSTRUÇÕES IMPORTANTES:');
    console.log('   1. Acesse https://msapp.rf.gd/editar_prompt.php');
    console.log('   2. Configure um prompt FORTE de vendas');
    console.log('   3. Teste com GET /test-prompt para verificar');
    console.log('   4. Envie "Oi" para testar o comportamento');
  });
}

startServer().catch(console.error);