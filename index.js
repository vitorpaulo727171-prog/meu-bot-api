const express = require('express');
const OpenAI = require('openai');
const mysql = require('mysql2/promise');

const app = express();
app.use(express.json());

// Configurações da API
const token = process.env.GITHUB_TOKEN;
const endpoint = "https://models.github.ai/inference";
const model = "openai/gpt-4.1";

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

// Verifica se as variáveis necessárias estão disponíveis
if (!token) {
  console.error("ERRO: GITHUB_TOKEN não encontrado nas variáveis de ambiente");
  process.exit(1);
}

const client = new OpenAI({
  baseURL: endpoint,
  apiKey: token
});

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
    console.error('📋 Código do erro:', error.code);
    return false;
  }
}

async function initializeDatabase() {
  console.log('🔄 Inicializando MySQL para Railway...');
  
  // Verifica se as configurações estão definidas
  if (!dbConfig.host || !dbConfig.user || !dbConfig.password || !dbConfig.database) {
    console.log('🚫 Configurações do MySQL incompletas:');
    console.log(`   Host: ${dbConfig.host}`);
    console.log(`   User: ${dbConfig.user}`);
    console.log(`   Database: ${dbConfig.database}`);
    console.log(`   Password: ${dbConfig.password ? '***' : 'AUSENTE'}`);
    mysqlEnabled = false;
    return;
  }

  // Testa conexão básica primeiro
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

    // Testa a conexão do pool
    const connection = await pool.getConnection();
    console.log('✅ Pool MySQL conectado com sucesso');
    
    // Cria a tabela se não existir (versão simplificada)
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
    console.log('✅ Tabela conversations verificada/criada');
    
    // Testa inserção e leitura
    console.log('🔄 Testando inserção e leitura...');
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
      
      // Limpa teste
      await connection.execute(`DELETE FROM conversations WHERE id = ?`, [insertResult.insertId]);
    } else {
      console.error('❌ Teste de inserção/leitura falhou');
    }
    
    connection.release();
    mysqlEnabled = true;
    console.log('🎉 MySQL totalmente inicializado e funcionando!');
    
  } catch (error) {
    console.error('❌ Erro na inicialização do MySQL:', error.message);
    console.error('📋 Código do erro:', error.code);
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

// Função para buscar histórico de conversas (CORRIGIDA - sem LIMIT com parâmetro)
async function getConversationHistory(senderName, groupName, isMessageFromGroup, limit = 6) {
  if (!mysqlEnabled || !pool) {
    console.log('⚠️  MySQL não disponível, sem histórico');
    return [];
  }

  try {
    const sessionId = generateSessionId(senderName, groupName, isMessageFromGroup);
    
    console.log(`📚 Buscando histórico para sessão: ${sessionId}`);
    
    // CORREÇÃO: Usar template string para LIMIT em vez de parâmetro
    const safeLimit = parseInt(limit);
    const [rows] = await pool.execute(
      `SELECT sender_message, ai_response, created_at 
       FROM conversations 
       WHERE session_id = ? 
       ORDER BY created_at DESC 
       LIMIT ${safeLimit}`,  // LIMIT fixo na query, não como parâmetro
      [sessionId]
    );
    
    console.log(`✅ Histórico carregado: ${rows.length} mensagens`);
    return rows.reverse();
    
  } catch (error) {
    console.error('❌ Erro ao buscar histórico:', error.message);
    console.error('📋 Código do erro:', error.code);
    return [];
  }
}

// Função para limpar histórico antigo (CORRIGIDA)
async function cleanupOldMessages(senderName, groupName, isMessageFromGroup) {
  if (!mysqlEnabled || !pool) return;

  try {
    const sessionId = generateSessionId(senderName, groupName, isMessageFromGroup);
    
    // Método alternativo mais simples
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

    // Busca histórico recente da conversa
    const history = await getConversationHistory(senderName, groupName, isMessageFromGroup, 6);
    
    // Prepara o contexto com histórico
    const messages = [
      {
        role: "system",
        content: `Você é um assistente virtual da Loja 'Mercado dos Sabores'. Seja prestativo, educado e claro nas respostas.

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
• Site para Encomendas: https://lojams.rf.gd 
• Produtos marcados como INDISPONÍVEL estão sem estoque no momento

Orientação: Sempre informe o preço e disponibilidade quando mencionar produtos. Para itens sem estoque, sugira alternativas similares. Direcione o cliente ao site para ver fotos e fazer pedidos.
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

    // Processa a mensagem com a IA
    const response = await client.chat.completions.create({
      messages: messages,
      temperature: 0.7,
      top_p: 1.0,
      model: model
    });

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
    
    res.json({
      data: [{
        message: "Desculpe, estou tendo problemas técnicos. Tente novamente!"
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

// Rota para status do banco
app.get('/db-status', async (req, res) => {
  try {
    if (!mysqlEnabled || !pool) {
      return res.json({
        status: 'disabled',
        message: 'MySQL não está habilitado',
        mysqlEnabled: mysqlEnabled,
        poolExists: !!pool
      });
    }

    // Teste de conexão
    const [testResult] = await pool.execute('SELECT 1 as connection_test');
    
    // Contagem de conversas
    const [countResult] = await pool.execute('SELECT COUNT(*) as total FROM conversations');
    
    // Últimas conversas
    const [recentConversations] = await pool.execute(
      'SELECT id, sender_name, created_at FROM conversations ORDER BY id DESC LIMIT 5'
    );

    res.json({
      status: 'connected',
      message: 'MySQL Railway está funcionando perfeitamente!',
      connectionTest: testResult[0].connection_test,
      totalConversations: countResult[0].total,
      recentConversations: recentConversations,
      config: {
        host: dbConfig.host,
        database: dbConfig.database,
        user: dbConfig.user,
        port: dbConfig.port
      }
    });
    
  } catch (error) {
    res.json({
      status: 'error',
      message: 'Erro no MySQL Railway',
      error: error.message,
      mysqlEnabled: mysqlEnabled
    });
  }
});

// Rota para testar a query problemática
app.get('/test-limit-query', async (req, res) => {
  try {
    if (!mysqlEnabled || !pool) {
      return res.json({ error: 'MySQL não disponível' });
    }

    const testResults = {};
    
    // Teste 1: Query com LIMIT como string template (deve funcionar)
    const [test1] = await pool.execute(
      `SELECT sender_message, ai_response, created_at 
       FROM conversations 
       WHERE session_id = ? 
       ORDER BY created_at DESC 
       LIMIT 5`,  // LIMIT fixo
      ['test_user']
    );
    testResults.limit_fixed = test1;
    
    // Teste 2: Query com LIMIT como parâmetro (pode falhar)
    try {
      const [test2] = await pool.execute(
        `SELECT sender_message, ai_response, created_at 
         FROM conversations 
         WHERE session_id = ? 
         ORDER BY created_at DESC 
         LIMIT ?`,
        ['test_user', 5]
      );
      testResults.limit_parameter = { success: true, data: test2 };
    } catch (error) {
      testResults.limit_parameter = { success: false, error: error.message };
    }
    
    res.json({
      status: 'success',
      tests: testResults
    });
    
  } catch (error) {
    res.json({
      status: 'error',
      message: 'Erro nos testes de LIMIT',
      error: error.message
    });
  }
});

// Rota específica para uptime monitoring
app.get('/ping', (req, res) => {
  res.status(200).json({
    status: 'OK',
    mysql: mysqlEnabled ? 'connected' : 'disabled',
    timestamp: new Date().toISOString(),
    service: 'Railway MySQL'
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
      timestamp: new Date().toISOString(),
      uptime: Math.floor(process.uptime()) + ' segundos',
      service: 'Railway MySQL'
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
    service: 'AutoReply Webhook com Railway MySQL',
    status: 'Online',
    mysql: mysqlEnabled ? 'CONECTADO' : 'DESCONECTADO',
    deployment: 'Railway',
    endpoints: {
      webhook: 'POST /webhook',
      health: 'GET /health',
      ping: 'GET /ping',
      db_status: 'GET /db-status',
      test_limit_query: 'GET /test-limit-query',
      conversations: 'GET /conversations (admin)'
    }
  });
});

// Inicializa o servidor
async function startServer() {
  console.log('🚀 Iniciando servidor AutoReply com MySQL Railway...');
  console.log('🔧 String de conexão detectada:');
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
    console.log(`📊 Status MySQL: GET /db-status`);
    console.log(`🧪 Teste de LIMIT: GET /test-limit-query`);
    console.log(`🗃️  MySQL: ${mysqlEnabled ? '✅ CONECTADO' : '❌ DESCONECTADO'}`);
    
    if (mysqlEnabled) {
      console.log('\n🎯 PRONTO! Agora sua IA tem:');
      console.log('   ✅ Histórico de conversas');
      console.log('   ✅ Contexto por usuário/grupo');
      console.log('   ✅ Respostas mais inteligentes');
      console.log('\n💬 Teste enviando uma mensagem pelo AutoReply!');
    }
  });
}

startServer().catch(console.error);
