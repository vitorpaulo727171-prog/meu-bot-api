const express = require('express');
const OpenAI = require('openai');
const mysql = require('mysql2/promise');

const app = express();
app.use(express.json());

// Configurações da API
const token = process.env.GITHUB_TOKEN;
const endpoint = "https://models.github.ai/inference";
const model = "openai/gpt-4.1";

// Configurações do MySQL
const dbConfig = {
  host: process.env.MYSQL_HOST,
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  port: process.env.MYSQL_PORT || 3306
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

async function initializeDatabase() {
  try {
    pool = mysql.createPool({
      ...dbConfig,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0
    });

    // Testa a conexão
    const connection = await pool.getConnection();
    console.log('✅ Conectado ao MySQL com sucesso');
    
    // Cria a tabela se não existir
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
    
    connection.release();
  } catch (error) {
    console.error('❌ Erro ao conectar com MySQL:', error.message);
    // Não encerra o processo, apenas loga o erro
  }
}

// Função para gerar session_id (usuário + grupo ou apenas usuário)
function generateSessionId(senderName, groupName, isMessageFromGroup) {
  if (isMessageFromGroup && groupName) {
    return `group_${groupName}_user_${senderName}`;
  }
  return `user_${senderName}`;
}

// Função para salvar conversa no banco
async function saveConversation(conversationData) {
  if (!pool) {
    console.log('⚠️  MySQL não disponível, pulando salvamento');
    return null;
  }

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
        conversationData.senderName,
        conversationData.groupName,
        conversationData.isMessageFromGroup || false,
        conversationData.senderMessage,
        conversationData.aiResponse,
        conversationData.messageDateTime,
        conversationData.receiveMessageApp || 'unknown'
      ]
    );
    console.log(`💾 Conversa salva - Sessão: ${sessionId}, ID: ${result.insertId}`);
    return result.insertId;
  } catch (error) {
    console.error('❌ Erro ao salvar conversa:', error.message);
    return null;
  }
}

// Função para buscar histórico de conversas (últimas 10 mensagens da sessão)
async function getConversationHistory(senderName, groupName, isMessageFromGroup, limit = 10) {
  if (!pool) {
    console.log('⚠️  MySQL não disponível, retornando histórico vazio');
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
    
    console.log(`📚 Histórico carregado: ${rows.length} mensagens para sessão ${sessionId}`);
    return rows.reverse(); // Retorna do mais antigo para o mais recente
  } catch (error) {
    console.error('❌ Erro ao buscar histórico:', error.message);
    return [];
  }
}

// Função para limpar histórico antigo (manter apenas últimas 20 mensagens por sessão)
async function cleanupOldMessages(senderName, groupName, isMessageFromGroup) {
  if (!pool) return;

  try {
    const sessionId = generateSessionId(senderName, groupName, isMessageFromGroup);
    
    await pool.execute(
      `DELETE FROM conversations 
       WHERE session_id = ? AND id NOT IN (
         SELECT id FROM (
           SELECT id FROM conversations 
           WHERE session_id = ? 
           ORDER BY created_at DESC 
           LIMIT 20
         ) AS temp
       )`,
      [sessionId, sessionId]
    );
  } catch (error) {
    console.error('❌ Erro ao limpar mensagens antigas:', error.message);
  }
}

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

    console.log(`📩 Mensagem recebida de ${senderName}${groupName ? ` no grupo ${groupName}` : ''}: ${senderMessage}`);

    // Busca histórico recente da conversa
    const history = await getConversationHistory(senderName, groupName, isMessageFromGroup, 8);
    
    // Prepara o contexto com histórico
    const messages = [
      {
        role: "system",
        content: `Você é um assistente útil e amigável. Responda de forma natural, concisa e em português.
        Mantenha o contexto da conversa anterior. Seja breve mas prestativo.
        ${groupName ? `Estamos no grupo "${groupName}".` : `Conversando com ${senderName}.`}`
      }
    ];

    // Adiciona histórico ao contexto (formato: user -> assistant)
    history.forEach(conv => {
      messages.push({ role: "user", content: conv.sender_message });
      messages.push({ role: "assistant", content: conv.ai_response });
    });

    // Adiciona a mensagem atual
    messages.push({ role: "user", content: senderMessage });

    console.log(`🤖 Processando com ${messages.length} mensagens de contexto...`);

    // Processa a mensagem com a IA
    const response = await client.chat.completions.create({
      messages: messages,
      temperature: 0.7,
      top_p: 1.0,
      model: model
    });

    const aiResponse = response.choices[0].message.content;

    // Salva a conversa no banco
    await saveConversation({
      senderName,
      groupName,
      isMessageFromGroup,
      senderMessage,
      aiResponse,
      messageDateTime,
      receiveMessageApp
    });

    // Limpa mensagens antigas para não sobrecarregar o banco
    await cleanupOldMessages(senderName, groupName, isMessageFromGroup);

    console.log(`✅ Resposta gerada: ${aiResponse.substring(0, 100)}...`);

    // Retorna a resposta no formato esperado pelo AutoReply
    res.json({
      data: [{
        message: aiResponse
      }]
    });

  } catch (error) {
    console.error('❌ Erro ao processar mensagem:', error);
    
    // Resposta de fallback em caso de erro
    res.json({
      data: [{
        message: "Desculpe, estou tendo problemas técnicos no momento. Poderia tentar novamente em alguns instantes?"
      }]
    });
  }
});

// Rota para visualizar conversas (apenas para administração)
app.get('/conversations', async (req, res) => {
  if (!pool) {
    return res.status(500).json({ error: 'MySQL não disponível' });
  }

  try {
    const [rows] = await pool.execute(
      `SELECT * FROM conversations ORDER BY created_at DESC LIMIT 50`
    );
    res.json(rows);
  } catch (error) {
    console.error('Erro ao buscar conversas:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Rota específica para uptime monitoring
app.get('/ping', (req, res) => {
  res.status(200).send('OK');
});

// Rota de health check
app.get('/health', async (req, res) => {
  try {
    let dbStatus = 'unknown';
    if (pool) {
      try {
        await pool.execute('SELECT 1');
        dbStatus = 'connected';
      } catch (error) {
        dbStatus = 'disconnected';
      }
    }

    res.status(200).json({ 
      status: 'OK', 
      database: dbStatus,
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
    service: 'AutoReply Webhook com Contexto MySQL',
    status: 'Online',
    features: [
      'Histórico de conversas',
      'Contexto por usuário/grupo',
      'Respostas contextualizadas'
    ],
    endpoints: {
      webhook: 'POST /webhook',
      health: 'GET /health',
      ping: 'GET /ping',
      conversations: 'GET /conversations (admin)'
    }
  });
});

// Inicializa o servidor
async function startServer() {
  await initializeDatabase();
  
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`🚀 Servidor rodando na porta ${PORT}`);
    console.log(`📝 Webhook URL: http://localhost:${PORT}/webhook`);
    console.log(`🔄 Ping URL: http://localhost:${PORT}/ping`);
    if (pool) {
      console.log(`🗃️  MySQL integrado para contexto de conversas`);
    } else {
      console.log(`⚠️  MySQL não disponível - funcionando sem contexto`);
    }
  });
}

startServer().catch(console.error);
