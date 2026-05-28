const express = require('express');
const OpenAI = require('openai');
const mysql = require('mysql2/promise');

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

// Função para obter data e hora formatadas
function getCurrentDateTime() {
  const now = new Date();

  now.setTime(now.getTime() - 3 * 60 * 60 * 1000);
  
  // Formato para o Brasil (DD/MM/AAAA HH:MM:SS)
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
        temperature: 0.3,
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

// Função para manter o MySQL ativo
async function keepMySQLAlive() {
  if (!mysqlEnabled || !pool) {
    console.log('⚠️  MySQL não disponível para keep-alive');
    return false;
  }

  try {
    const [rows] = await pool.execute('SELECT 1 as keep_alive');
    console.log('✅ Keep-alive MySQL executado com sucesso');
    return true;
  } catch (error) {
    console.error('❌ Erro no keep-alive MySQL:', error.message);
    
    // Tentar reconectar se houver erro
    try {
      console.log('🔄 Tentando reconectar ao MySQL...');
      await initializeDatabase();
    } catch (reconnectError) {
      console.error('❌ Falha na reconexão MySQL:', reconnectError.message);
    }
    
    return false;
  }
}

// Função para buscar produtos de pronta entrega
async function getProntaEntregaProducts() {
  if (!mysqlEnabled || !pool) {
    console.log('⚠️  MySQL não disponível, usando produtos padrão');
    return null;
  }

  try {
    const [rows] = await pool.execute(
      `SELECT nome, descricao, preco, estoque FROM produtos_pronta_entrega WHERE disponibilidade = 'Pronta Entrega' AND estoque > 0`
    );

    if (rows.length === 0) {
      return "Nenhum produto disponível para pronta entrega no momento.";
    }

    let productsString = "📦 PRODUTOS DISPONÍVEIS – PRONTA ENTREGA\n\n";
    rows.forEach(product => {
      productsString += `• ${product.nome}\n`;
      productsString += `• Descrição: ${product.descricao}\n`;
      productsString += `• Preço: R$ ${product.preco} cada\n`;
      productsString += `• Estoque: ${product.estoque} unidades\n`;
      productsString += `• Disponibilidade: ✅ Pronta Entrega\n\n`;
    });

    return productsString;
  } catch (error) {
    console.error('❌ Erro ao buscar produtos de pronta entrega:', error.message);
    return null;
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
    
    // Cria a tabela conversations se não existir
    console.log('🔄 Verificando/Criando tabela conversations...');
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
    
    // Cria a tabela produtos_pronta_entrega se não existir
    console.log('🔄 Verificando/Criando tabela produtos_pronta_entrega...');
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS produtos_pronta_entrega (
        id INT AUTO_INCREMENT PRIMARY KEY,
        nome VARCHAR(100) NOT NULL,
        descricao TEXT,
        preco DECIMAL(10,2) NOT NULL,
        estoque INT NOT NULL,
        disponibilidade ENUM('Pronta Entrega') DEFAULT 'Pronta Entrega'
      )
    `);
    
    console.log('✅ Tabelas verificadas/criadas');
    
    // Testa a funcionalidade de produtos
    console.log('🔄 Testando busca de produtos...');
    const produtosTeste = await getProntaEntregaProducts();
    console.log('✅ Teste de produtos:', produtosTeste ? 'OK' : 'FALHOU');
    
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

    // Obtém data e hora atual
    const currentDateTime = getCurrentDateTime();
    console.log(`📅 Data/Hora atual: ${currentDateTime.full}`);

    // Busca produtos de pronta entrega do banco
    const prontaEntregaProducts = await getProntaEntregaProducts();

    // Busca histórico recente da conversa
    const history = await getConversationHistory(senderName, groupName, isMessageFromGroup, 6);
    
    // Prepara o contexto com histórico e produtos dinâmicos
    const messages = [
      {
        role: "system",
        content: `Voce e um super inteligente e consegue responder todas as perguntas'
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

// ... (o restante do código permanece igual - rotas administrativas, inicialização do servidor, etc.)

// Rotas administrativas para gerenciar produtos
app.get('/produtos', async (req, res) => {
  if (!mysqlEnabled || !pool) {
    return res.status(500).json({ error: 'MySQL não disponível' });
  }

  try {
    const [rows] = await pool.execute('SELECT * FROM produtos_pronta_entrega');
    res.json({
      status: 'success',
      count: rows.length,
      data: rows
    });
  } catch (error) {
    console.error('Erro ao buscar produtos:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

app.post('/produtos', async (req, res) => {
  if (!mysqlEnabled || !pool) {
    return res.status(500).json({ error: 'MySQL não disponível' });
  }

  try {
    const { nome, descricao, preco, estoque } = req.body;
    
    const [result] = await pool.execute(
      'INSERT INTO produtos_pronta_entrega (nome, descricao, preco, estoque) VALUES (?, ?, ?, ?)',
      [nome, descricao, preco, estoque]
    );
    
    res.json({
      status: 'success',
      message: 'Produto adicionado com sucesso',
      id: result.insertId
    });
  } catch (error) {
    console.error('Erro ao adicionar produto:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

app.put('/produtos/:id', async (req, res) => {
  if (!mysqlEnabled || !pool) {
    return res.status(500).json({ error: 'MySQL não disponível' });
  }

  try {
    const { id } = req.params;
    const { nome, descricao, preco, estoque } = req.body;
    
    await pool.execute(
      'UPDATE produtos_pronta_entrega SET nome = ?, descricao = ?, preco = ?, estoque = ? WHERE id = ?',
      [nome, descricao, preco, estoque, id]
    );
    
    res.json({
      status: 'success',
      message: 'Produto atualizado com sucesso'
    });
  } catch (error) {
    console.error('Erro ao atualizar produto:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

app.delete('/produtos/:id', async (req, res) => {
  if (!mysqlEnabled || !pool) {
    return res.status(500).json({ error: 'MySQL não disponível' });
  }

  try {
    const { id } = req.params;
    
    await pool.execute('DELETE FROM produtos_pronta_entrega WHERE id = ?', [id]);
    
    res.json({
      status: 'success',
      message: 'Produto removido com sucesso'
    });
  } catch (error) {
    console.error('Erro ao remover produto:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Rotas existentes (conversations, status, rotate-api, ping, health) mantidas iguais
app.get('/conversations', async (req, res) => {
  if (!mysqlEnabled || !pool) {
    return res.status(500).json({ error: 'MySQL não disponível' });
  }

  try {
    const [rows] = await pool.execute('SELECT * FROM conversations ORDER BY created_at DESC LIMIT 50');
    res.json({ status: 'success', count: rows.length, data: rows });
  } catch (error) {
    console.error('Erro ao buscar conversas:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
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
      apis: { total: API_KEYS.length, current: currentApiIndex, statistics: apiStats },
      model: model,
      timestamp: new Date().toISOString(),
      currentDateTime: getCurrentDateTime(),
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
    total_apis: API_KEYS.length
  });
});

// ROTA PING MODIFICADA - Agora mantém o MySQL ativo
app.get('/ping', async (req, res) => {
  try {
    // Executa keep-alive do MySQL se estiver disponível
    let mysqlAlive = false;
    if (mysqlEnabled && pool) {
      mysqlAlive = await keepMySQLAlive();
    }

    res.status(200).json({
      status: 'OK',
      mysql: mysqlEnabled ? (mysqlAlive ? 'connected' : 'error') : 'disabled',
      apis: { total: API_KEYS.length, current: currentApiIndex },
      model: model,
      timestamp: new Date().toISOString(),
      currentDateTime: getCurrentDateTime(),
      service: 'Railway MySQL + Multi-API',
      mysql_keep_alive: mysqlAlive
    });
  } catch (error) {
    console.error('❌ Erro na rota /ping:', error);
    res.status(500).json({ 
      status: 'Error', 
      message: 'Service ping failed',
      mysql_keep_alive: false
    });
  }
});

app.get('/health', async (req, res) => {
  try {
    let dbStatus = 'disabled';
    let mysqlAlive = false;
    
    if (mysqlEnabled && pool) {
      try {
        await pool.execute('SELECT 1');
        dbStatus = 'connected';
        mysqlAlive = true;
      } catch (error) {
        dbStatus = 'error';
        mysqlAlive = false;
      }
    }

    res.status(200).json({ 
      status: 'OK', 
      database: dbStatus,
      mysqlEnabled: mysqlEnabled,
      mysql_alive: mysqlAlive,
      apis: { total: API_KEYS.length, current: currentApiIndex },
      model: model,
      timestamp: new Date().toISOString(),
      currentDateTime: getCurrentDateTime(),
      uptime: Math.floor(process.uptime()) + ' segundos'
    });
  } catch (error) {
    res.status(500).json({ 
      status: 'Error', 
      message: 'Service unhealthy',
      mysql_alive: false
    });
  }
});

app.get('/', (req, res) => {
  const currentDateTime = getCurrentDateTime();
  
  res.json({ 
    service: 'AutoReply Webhook com Multi-API + MySQL + Produtos Dinâmicos',
    status: 'Online',
    mysql: mysqlEnabled ? 'CONECTADO' : 'DESCONECTADO',
    apis: { total: API_KEYS.length, current: currentApiIndex },
    model: model,
    deployment: 'Railway',
    currentDateTime: currentDateTime,
    endpoints: {
      webhook: 'POST /webhook',
      health: 'GET /health',
      status: 'GET /status',
      ping: 'GET /ping (com keep-alive MySQL)',
      'rotate-api': 'POST /rotate-api',
      conversations: 'GET /conversations',
      produtos: 'GET/POST/PUT/DELETE /produtos'
    },
    note: 'A IA agora tem acesso à data e hora atual para melhor atendimento'
  });
});

// Inicializa o servidor
async function startServer() {
  console.log('🚀 Iniciando servidor AutoReply com Produtos Dinâmicos...');
  console.log(`🔑 ${API_KEYS.length} chaves API configuradas`);
  console.log(`🤖 Modelo: ${model}`);
  
  await initializeDatabase();
  
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    const currentDateTime = getCurrentDateTime();
    console.log(`🎉 Servidor rodando na porta ${PORT}`);
    console.log(`🌐 Webhook: POST /webhook`);
    console.log(`🛍️  Gerenciar produtos: GET/POST/PUT/DELETE /produtos`);
    console.log(`🗃️  MySQL: ${mysqlEnabled ? '✅ CONECTADO' : '❌ DESCONECTADO'}`);
    console.log(`🔋 Keep-alive MySQL: ✅ ATIVO via rota /ping`);
    console.log(`📅 Data/Hora do servidor: ${currentDateTime.full}`);
    
    console.log('\n🎯 SISTEMA DE PRODUTOS DINÂMICOS CONFIGURADO:');
    console.log(`   ✅ Tabela produtos_pronta_entrega criada/verificada`);
    console.log(`   ✅ Consulta automática a cada mensagem`);
    console.log(`   ✅ APIs REST para gerenciamento`);
    console.log(`   ✅ Fallback para produtos padrão se MySQL falhar`);
    console.log(`   ✅ Sistema keep-alive MySQL para evitar dormência`);
    console.log(`   ✅ Data e hora disponíveis para a IA`);
  });
}

startServer().catch(console.error);
