const express = require('express');
const OpenAI = require('openai');
const mysql = require('mysql2/promise');

const app = express();
app.use(express.json());

// Configurações da API
const token = process.env.GITHUB_TOKEN;
const endpoint = "https://models.github.ai/inference";
const model = "openai/gpt-4.1";

// Configurações do MySQL - Railway
// Railway fornece DATABASE_URL no formato: mysql://user:password@host:port/database
let dbConfig;

if (process.env.DATABASE_URL) {
  // Parse da DATABASE_URL do Railway
  const url = new URL(process.env.DATABASE_URL);
  dbConfig = {
    host: url.hostname,
    port: url.port || 3306,
    user: url.username,
    password: url.password,
    database: url.pathname.replace('/', ''),
    // Configurações otimizadas para Railway
    connectTimeout: 10000,
    acquireTimeout: 10000,
    timeout: 10000,
    charset: 'utf8mb4'
  };
} else {
  // Fallback para variáveis individuais
  dbConfig = {
    host: process.env.MYSQLHOST || process.env.MYSQL_HOST,
    port: process.env.MYSQLPORT || process.env.MYSQL_PORT || 3306,
    user: process.env.MYSQLUSER || process.env.MYSQL_USER,
    password: process.env.MYSQLPASSWORD || process.env.MYSQL_PASSWORD,
    database: process.env.MYSQLDATABASE || process.env.MYSQL_DATABASE,
    connectTimeout: 10000,
    acquireTimeout: 10000,
    timeout: 10000,
    charset: 'utf8mb4'
  };
}

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
  
  // Verifica se as configurações estão definidas
  if (!dbConfig.host || !dbConfig.user || !dbConfig.password || !dbConfig.database) {
    console.log('🚫 Configurações do MySQL não encontradas');
    console.log('   Railway deve fornecer DATABASE_URL ou variáveis MYSQL_*');
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
      connectionLimit: 10, // Railway permite boas conexões
      queueLimit: 0,
      acquireTimeout: 10000,
      timeout: 10000,
    });

    // Testa a conexão do pool
    const connection = await pool.getConnection();
    console.log('✅ Pool MySQL conectado com sucesso');
    
    // Cria a tabela se não existir
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
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX session_index (session_id),
        INDEX sender_index (sender_name)
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
    console.error('📋 Detalhes do erro:', error.code);
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
        conversationData.senderName,
        conversationData.groupName,
        conversationData.isMessageFromGroup || false,
        conversationData.senderMessage,
        conversationData.aiResponse,
        conversationData.messageDateTime,
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
    
    const [rows] = await pool.execute(
      `SELECT sender_message, ai_response, created_at 
       FROM conversations 
       WHERE session_id = ? 
       ORDER BY created_at DESC 
       LIMIT ?`,
      [sessionId, limit]
    );
    
    console.log(`📚 Histórico carregado: ${rows.length} mensagens`);
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
    
    // Método compatível com MySQL do Railway
    await pool.execute(
      `DELETE FROM conversations 
       WHERE session_id = ? AND id NOT IN (
         SELECT id FROM (
           SELECT id FROM conversations 
           WHERE session_id = ? 
           ORDER BY created_at DESC 
           LIMIT 15
         ) AS temp
       )`,
      [sessionId, sessionId]
    );
    
    console.log(`🧹 Mensagens antigas limpas para: ${sessionId}`);
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

    console.log(`🤖 Processando com ${messages.length} mensagens de contexto`);

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

    console.log(`✅ Resposta gerada (MySQL: ${savedId ? 'SALVO' : 'NÃO SALVO'})`);

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
app.get('/railway-db', async (req, res) => {
  try {
    if (!mysqlEnabled || !pool) {
      return res.json({
        status: 'disabled',
        message: 'MySQL não está habilitado',
        mysqlEnabled: mysqlEnabled,
        config: {
          hasDatabaseUrl: !!process.env.DATABASE_URL,
          host: dbConfig.host,
          database: dbConfig.database
        }
      });
    }

    // Teste de conexão
    const [testResult] = await pool.execute('SELECT 1 as connection_test');
    
    // Contagem de conversas
    const [countResult] = await pool.execute('SELECT COUNT(*) as total FROM conversations');
    
    // Informações do banco
    const [dbInfo] = await pool.execute('SELECT DATABASE() as db, NOW() as server_time');

    res.json({
      status: 'connected',
      message: 'Railway MySQL está funcionando',
      connectionTest: testResult[0].connection_test,
      totalConversations: countResult[0].total,
      databaseInfo: dbInfo[0],
      config: {
        host: dbConfig.host,
        database: dbConfig.database,
        user: dbConfig.user
      }
    });
    
  } catch (error) {
    res.json({
      status: 'error',
      message: 'Erro no Railway MySQL',
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
    service: 'Railway'
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
      railway_db: 'GET /railway_db',
      conversations: 'GET /conversations (admin)'
    }
  });
});

// Inicializa o servidor
async function startServer() {
  console.log('🚀 Iniciando servidor AutoReply no Railway...');
  console.log('🔧 Configurações detectadas:');
  console.log(`   - DATABASE_URL: ${process.env.DATABASE_URL ? 'PRESENTE' : 'AUSENTE'}`);
  console.log(`   - GitHub Token: ${token ? 'PRESENTE' : 'AUSENTE'}`);
  
  await initializeDatabase();
  
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`🎉 Servidor rodando na porta ${PORT}`);
    console.log(`🌐 Webhook: https://seu-app.railway.app/webhook`);
    console.log(`🔍 Health: https://seu-app.railway.app/health`);
    console.log(`🗃️  MySQL: ${mysqlEnabled ? '✅ CONECTADO' : '❌ DESCONECTADO'}`);
    
    if (!mysqlEnabled) {
      console.log('\n📝 Para conectar MySQL no Railway:');
      console.log('   1. No painel do Railway, adicione "MySQL" como plugin');
      console.log('   2. O Railway automaticamente fornece DATABASE_URL');
      console.log('   3. Reinicie o serviço após adicionar o MySQL');
    }
  });
}

startServer().catch(console.error);
