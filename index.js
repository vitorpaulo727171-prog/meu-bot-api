const express = require('express');
const OpenAI = require('openai');
const mysql = require('mysql2/promise');
const dns = require('dns').promises;

const app = express();
app.use(express.json());

// Configurações da API
const token = process.env.GITHUB_TOKEN;
const endpoint = "https://models.github.ai/inference";
const model = "openai/gpt-4.1";

// Configurações do MySQL - InfinityFree
const dbConfig = {
  host: process.env.MYSQL_HOST,
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  port: process.env.MYSQL_PORT || 3306,
  // Configurações otimizadas para InfinityFree
  connectTimeout: 15000,
  acquireTimeout: 15000,
  timeout: 15000,
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

// Função para verificar DNS do host MySQL
async function verifyMySQLHost() {
  if (!dbConfig.host) {
    console.error('❌ Host MySQL não configurado');
    return false;
  }

  console.log('🔍 Verificando DNS do host MySQL...');
  console.log(`   Host: ${dbConfig.host}`);
  
  try {
    const addresses = await dns.lookup(dbConfig.host);
    console.log(`✅ DNS resolvido: ${dbConfig.host} -> ${addresses.address}`);
    return true;
  } catch (dnsError) {
    console.error('❌ ERRO DNS: Não foi possível resolver o hostname:', dbConfig.host);
    console.error('   Detalhes:', dnsError.message);
    console.log('\n💡 SOLUÇÕES PARA INFINITYFREE:');
    console.log('   1. Verifique se o hostname está correto (ex: sql206.infinityfree.com)');
    console.log('   2. O InfinityFree pode estar bloqueando conexões externas');
    console.log('   3. Verifique se o serviço MySQL está ativo no painel InfinityFree');
    return false;
  }
}

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
    console.log('💡 Possíveis causas:');
    console.log('   - Credenciais incorretas');
    console.log('   - Database não existe');
    console.log('   - Usuário sem permissões');
    console.log('   - Servidor MySQL não aceita conexões externas');
    return false;
  }
}

// Função para verificar estrutura da tabela
async function verifyTableStructure() {
  try {
    const [rows] = await pool.execute(`
      SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE 
      FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_NAME = 'conversations' 
      AND TABLE_SCHEMA = ?
    `, [dbConfig.database]);
    
    console.log(`📋 Estrutura da tabela: ${rows.length} colunas encontradas`);
    
    const requiredColumns = ['session_id', 'sender_name', 'sender_message', 'ai_response'];
    const existingColumns = rows.map(row => row.COLUMN_NAME);
    
    const missingColumns = requiredColumns.filter(col => !existingColumns.includes(col));
    
    if (missingColumns.length > 0) {
      console.error(`❌ Colunas faltando: ${missingColumns.join(', ')}`);
      return false;
    }
    
    console.log('✅ Estrutura da tabela: OK');
    return true;
  } catch (error) {
    console.error('❌ Erro ao verificar estrutura da tabela:', error.message);
    return false;
  }
}

async function initializeDatabase() {
  console.log('🔄 Inicializando MySQL para InfinityFree...');
  
  // Verifica DNS primeiro
  const dnsOK = await verifyMySQLHost();
  if (!dnsOK) {
    console.log('🚫 MySQL desabilitado - problema de DNS');
    mysqlEnabled = false;
    return;
  }

  // Testa conexão básica
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
      connectionLimit: 3, // InfinityFree tem limite baixo
      queueLimit: 0,
      acquireTimeout: 15000,
      timeout: 15000,
    });

    // Testa a conexão do pool
    const connection = await pool.getConnection();
    console.log('✅ Pool MySQL conectado com sucesso');
    
    // Cria a tabela se não existir (versão simplificada para InfinityFree)
    console.log('🔄 Verificando/Criando tabela...');
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
    
    // Tenta criar índices (pode falhar no InfinityFree, mas não é crítico)
    try {
      await connection.execute('CREATE INDEX IF NOT EXISTS session_index ON conversations (session_id)');
      await connection.execute('CREATE INDEX IF NOT EXISTS sender_index ON conversations (sender_name)');
      console.log('✅ Índices criados/verificados');
    } catch (indexError) {
      console.log('⚠️  Índices podem já existir ou não suportados, continuando...');
    }
    
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

    console.log(`💾 Tentando salvar conversa para sessão: ${sessionId}`);
    
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
    
    console.log(`✅ Conversa salva com sucesso - ID: ${result.insertId}`);
    return result.insertId;
    
  } catch (error) {
    console.error('❌ Erro ao salvar conversa:', error.message);
    console.error('📋 Código do erro:', error.code);
    return null;
  }
}

// Função para buscar histórico de conversas
async function getConversationHistory(senderName, groupName, isMessageFromGroup, limit = 6) {
  if (!mysqlEnabled || !pool) {
    console.log('⚠️  MySQL não disponível, retornando histórico vazio');
    return [];
  }

  try {
    const sessionId = generateSessionId(senderName, groupName, isMessageFromGroup);
    
    console.log(`📚 Buscando histórico para sessão: ${sessionId}`);
    
    const [rows] = await pool.execute(
      `SELECT sender_message, ai_response, created_at 
       FROM conversations 
       WHERE session_id = ? 
       ORDER BY created_at DESC 
       LIMIT ?`,
      [sessionId, limit]
    );
    
    console.log(`✅ Histórico carregado: ${rows.length} mensagens`);
    return rows.reverse();
    
  } catch (error) {
    console.error('❌ Erro ao buscar histórico:', error.message);
    console.error('📋 Código do erro:', error.code);
    return [];
  }
}

// Função para limpar histórico antigo
async function cleanupOldMessages(senderName, groupName, isMessageFromGroup) {
  if (!mysqlEnabled || !pool) return;

  try {
    const sessionId = generateSessionId(senderName, groupName, isMessageFromGroup);
    
    // Método alternativo para limpeza (mais compatível)
    const [recentMessages] = await pool.execute(
      `SELECT id FROM conversations 
       WHERE session_id = ? 
       ORDER BY created_at DESC 
       LIMIT 15`,
      [sessionId]
    );
    
    if (recentMessages.length > 0) {
      const keepIds = recentMessages.map(msg => msg.id);
      await pool.execute(
        `DELETE FROM conversations 
         WHERE session_id = ? AND id NOT IN (?)`,
        [sessionId, keepIds]
      );
    }
    
    console.log(`🧹 Mensagens antigas limpas para sessão: ${sessionId}`);
  } catch (error) {
    console.error('❌ Erro ao limpar mensagens antigas:', error.message);
  }
}

// ROTA DE DIAGNÓSTICO COMPLETO
app.get('/debug_mysql', async (req, res) => {
  const debugInfo = {
    timestamp: new Date().toISOString(),
    mysqlEnabled: mysqlEnabled,
    poolExists: !!pool,
    config: {
      host: dbConfig.host,
      database: dbConfig.database,
      user: dbConfig.user,
      port: dbConfig.port
    },
    tests: {}
  };

  try {
    // Teste de DNS
    try {
      const dnsResult = await dns.lookup(dbConfig.host);
      debugInfo.tests.dns = {
        status: 'success',
        address: dnsResult.address
      };
    } catch (dnsError) {
      debugInfo.tests.dns = {
        status: 'failed',
        error: dnsError.message
      };
    }

    // Teste de conexão MySQL
    if (mysqlEnabled && pool) {
      try {
        const [testResult] = await pool.execute('SELECT 1 as test_value');
        debugInfo.tests.mysql_connection = {
          status: 'success',
          result: testResult[0]
        };

        // Teste de tabela
        try {
          const [tableResult] = await pool.execute('SELECT COUNT(*) as count FROM conversations');
          debugInfo.tests.table = {
            status: 'success',
            count: tableResult[0].count
          };
        } catch (tableError) {
          debugInfo.tests.table = {
            status: 'failed',
            error: tableError.message
          };
        }
      } catch (mysqlError) {
        debugInfo.tests.mysql_connection = {
          status: 'failed',
          error: mysqlError.message,
          code: mysqlError.code
        };
      }
    } else {
      debugInfo.tests.mysql_connection = { status: 'skipped', reason: 'MySQL not enabled' };
      debugInfo.tests.table = { status: 'skipped', reason: 'MySQL not enabled' };
    }

    res.json(debugInfo);
  } catch (error) {
    res.json({
      ...debugInfo,
      error: error.message
    });
  }
});

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
    console.log(`🗃️  MySQL status: ${mysqlEnabled ? 'HABILITADO' : 'DESABILITADO'}`);

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
      // Limpa mensagens antigas
      await cleanupOldMessages(senderName, groupName, isMessageFromGroup);
    }

    console.log(`✅ Resposta gerada (Salvo no MySQL: ${savedId ? 'SIM' : 'NÃO'}): ${aiResponse.substring(0, 100)}...`);

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
        message: "Desculpe, estou tendo problemas técnicos no momento. Poderia tentar novamente em alguns instantes?"
      }]
    });
  }
});

// Rota para visualizar conversas
app.get('/conversations', async (req, res) => {
  if (!mysqlEnabled || !pool) {
    return res.status(500).json({ 
      error: 'MySQL não disponível',
      mysqlEnabled: mysqlEnabled,
      poolExists: !!pool
    });
  }

  try {
    const [rows] = await pool.execute(
      `SELECT * FROM conversations ORDER BY created_at DESC LIMIT 50`
    );
    res.json({
      status: 'success',
      count: rows.length,
      mysqlEnabled: mysqlEnabled,
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

// Rota específica para uptime monitoring
app.get('/ping', (req, res) => {
  res.status(200).json({
    status: 'OK',
    mysql: mysqlEnabled ? 'connected' : 'disabled',
    timestamp: new Date().toISOString()
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
      uptime: process.uptime()
    });
  } catch (error) {
    res.status(500).json({ 
      status: 'Error', 
      message: 'Service unhealthy',
      error: error.message 
    });
  }
});

// Rota raiz
app.get('/', (req, res) => {
  res.json({ 
    service: 'AutoReply Webhook com MySQL',
    status: 'Online',
    mysql: mysqlEnabled ? 'ENABLED' : 'DISABLED',
    endpoints: {
      webhook: 'POST /webhook',
      health: 'GET /health',
      ping: 'GET /ping',
      'debug_mysql': 'GET /debug_mysql',
      conversations: 'GET /conversations'
    }
  });
});

// Inicializa o servidor
async function startServer() {
  console.log('🚀 Iniciando servidor...');
  console.log('🔧 Configurações MySQL:');
  console.log(`   - Host: ${dbConfig.host || 'NÃO CONFIGURADO'}`);
  console.log(`   - Database: ${dbConfig.database || 'NÃO CONFIGURADO'}`);
  console.log(`   - User: ${dbConfig.user || 'NÃO CONFIGURADO'}`);
  
  await initializeDatabase();
  
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`🎉 Servidor rodando na porta ${PORT}`);
    console.log(`🌐 URLs importantes:`);
    console.log(`   • Webhook: http://localhost:${PORT}/webhook`);
    console.log(`   • Health: http://localhost:${PORT}/health`);
    console.log(`   • Debug MySQL: http://localhost:${PORT}/debug_mysql`);
    console.log(`   • Ping: http://localhost:${PORT}/ping (UptimeRobot)`);
    console.log(`🗃️  MySQL: ${mysqlEnabled ? '✅ HABILITADO' : '❌ DESABILITADO'}`);
    
    if (!mysqlEnabled) {
      console.log('\n🔧 PARA HABILITAR MYSQL:');
      console.log('   1. Verifique as variáveis de ambiente no Render');
      console.log('   2. Acesse /debug_mysql para diagnóstico detalhado');
      console.log('   3. Confirme se o InfinityFree permite conexões externas');
    }
  });
}

startServer().catch(console.error);
