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

// Cache para otimização
let produtosCache = null;
let produtosCacheTimestamp = 0;
const CACHE_DURATION = 30000; // 30 segundos

let connectionTestCache = null;
let lastConnectionTest = 0;
const CONNECTION_TEST_INTERVAL = 60000; // 1 minuto

let lastKeepAlive = 0;
const KEEP_ALIVE_INTERVAL = 30000; // 30 segundos

let initializationPromise = null;

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

// Pré-compilação de queries SQL frequentes
const SQL_QUERIES = {
  INSERT_CONVERSATION: `INSERT INTO conversations 
       (session_id, sender_name, group_name, is_group_message, sender_message, ai_response, message_datetime, receive_message_app) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  
  SELECT_CONVERSATIONS: `SELECT sender_message, ai_response, created_at 
       FROM conversations 
       WHERE session_id = ? 
       ORDER BY created_at DESC 
       LIMIT ?`,
  
  SELECT_PRODUCTS: `SELECT nome, descricao, preco, estoque FROM produtos_pronta_entrega 
       WHERE disponibilidade = 'Pronta Entrega' AND estoque > 0 
       LIMIT 50`,
  
  KEEP_ALIVE: `SELECT 1 as keep_alive`,
  TEST_CONNECTION: `SELECT 1 as test`
};

// Otimização da formatação de data/hora
const dateTimeFormatter = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Sao_Paulo',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false
});

const weekdayFormatter = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Sao_Paulo',
  weekday: 'long'
});

// Verifica se há pelo menos uma chave API disponível
if (API_KEYS.length === 0) {
  console.error("ERRO: Nenhuma GITHUB_TOKEN encontrada nas variáveis de ambiente");
  process.exit(1);
}

console.log(`🔑 ${API_KEYS.length} chaves API configuradas`);

// Função para obter data e hora formatadas (OTIMIZADA)
function getCurrentDateTime() {
  const now = new Date();
  const formatted = dateTimeFormatter.formatToParts(now);
  const weekday = weekdayFormatter.format(now);
  
  const parts = {};
  formatted.forEach(part => {
    parts[part.type] = part.value;
  });

  return {
    date: `${parts.day}/${parts.month}/${parts.year}`,
    time: `${parts.hour}:${parts.minute}:${parts.second}`,
    full: `${parts.day}/${parts.month}/${parts.year} ${parts.hour}:${parts.minute}:${parts.second}`,
    weekday: weekday,
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

// Função para rotacionar para a próxima API (OTIMIZADA)
function rotateToNextApi() {
  const oldIndex = currentApiIndex;
  const totalApis = API_KEYS.length;
  
  // Encontra próxima API disponível (não rate limited recentemente)
  for (let i = 1; i <= totalApis; i++) {
    const nextIndex = (oldIndex + i) % totalApis;
    const rateLimitInfo = rateLimitStats[nextIndex];
    
    // Se não tem info de rate limit ou passou mais de 1 minuto, usa esta
    if (!rateLimitInfo || (Date.now() - rateLimitInfo.rateLimitedAt) > 60000) {
      currentApiIndex = nextIndex;
      console.log(`🔄 Rotacionando API: ${oldIndex} → ${currentApiIndex}`);
      return getCurrentClient();
    }
  }
  
  // Se todas estão com rate limit recente, usa a próxima mesmo assim
  currentApiIndex = (oldIndex + 1) % totalApis;
  console.log(`🔄 Rotacionando API (todas limitadas): ${oldIndex} → ${currentApiIndex}`);
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

// Função para testar conexão MySQL (OTIMIZADA com cache)
async function testMySQLConnection() {
  const now = Date.now();
  
  if (connectionTestCache && (now - lastConnectionTest) < CONNECTION_TEST_INTERVAL) {
    return connectionTestCache;
  }

  console.log('🔌 Testando conexão MySQL...');
  
  try {
    const testConnection = await mysql.createConnection(dbConfig);
    await testConnection.execute(SQL_QUERIES.TEST_CONNECTION);
    console.log('✅ Teste de conexão MySQL: OK');
    await testConnection.end();
    
    connectionTestCache = true;
    lastConnectionTest = now;
    return true;
  } catch (error) {
    console.error('❌ Teste de conexão MySQL falhou:', error.message);
    connectionTestCache = false;
    lastConnectionTest = now;
    return false;
  }
}

// Função para manter o MySQL ativo (OTIMIZADA)
async function keepMySQLAlive() {
  const now = Date.now();
  if (now - lastKeepAlive < KEEP_ALIVE_INTERVAL) {
    return true;
  }

  if (!mysqlEnabled || !pool) {
    console.log('⚠️  MySQL não disponível para keep-alive');
    return false;
  }

  try {
    const [rows] = await pool.execute(SQL_QUERIES.KEEP_ALIVE);
    lastKeepAlive = now;
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

// Função para buscar produtos de pronta entrega (OTIMIZADA com cache)
async function getProntaEntregaProducts() {
  const now = Date.now();
  
  // Retorna cache se ainda é válido
  if (produtosCache && (now - produtosCacheTimestamp) < CACHE_DURATION) {
    return produtosCache;
  }

  if (!mysqlEnabled || !pool) {
    console.log('⚠️  MySQL não disponível, usando produtos padrão');
    return "Nenhum produto disponível para pronta entrega no momento.";
  }

  try {
    const [rows] = await pool.execute(SQL_QUERIES.SELECT_PRODUCTS);

    if (rows.length === 0) {
      produtosCache = "Nenhum produto disponível para pronta entrega no momento.";
    } else {
      let productsString = "📦 PRODUTOS DISPONÍVEIS – PRONTA ENTREGA\n\n";
      // Usando for loop em vez de forEach para melhor performance
      for (let i = 0; i < rows.length; i++) {
        const product = rows[i];
        productsString += `🎂 ${product.nome}\n` +
                         `• Descrição: ${product.descricao}\n` +
                         `• Preço: R$ ${product.preco} cada\n` +
                         `• Estoque: ${product.estoque} unidades\n` +
                         `• Disponibilidade: ✅ Pronta Entrega\n\n`;
      }
      produtosCache = productsString;
    }

    produtosCacheTimestamp = now;
    return produtosCache;
  } catch (error) {
    console.error('❌ Erro ao buscar produtos de pronta entrega:', error.message);
    return "Nenhum produto disponível para pronta entrega no momento.";
  }
}

// Função para gerar session_id
function generateSessionId(senderName, groupName, isMessageFromGroup) {
  if (isMessageFromGroup && groupName) {
    return `group_${groupName}_user_${senderName}`;
  }
  return `user_${senderName}`;
}

// Função para salvar conversa no banco (OTIMIZADA)
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
      SQL_QUERIES.INSERT_CONVERSATION,
      [
        sessionId,
        conversationData.senderName || '',
        conversationData.groupName || '',
        conversationData.isMessageFromGroup ? 1 : 0,
        conversationData.senderMessage.substring(0, 4000) || '',
        conversationData.aiResponse.substring(0, 4000) || '',
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

// Função para buscar histórico de conversas (OTIMIZADA)
async function getConversationHistory(senderName, groupName, isMessageFromGroup, limit = 4) {
  if (!mysqlEnabled || !pool) {
    console.log('⚠️  MySQL não disponível, sem histórico');
    return [];
  }

  try {
    const sessionId = generateSessionId(senderName, groupName, isMessageFromGroup);
    
    console.log(`📚 Buscando histórico para sessão: ${sessionId}`);
    
    const safeLimit = Math.min(parseInt(limit), 10);
    const [rows] = await pool.execute(
      SQL_QUERIES.SELECT_CONVERSATIONS,
      [sessionId, safeLimit]
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

// Inicialização do banco (OTIMIZADA)
async function initializeDatabase() {
  // Evita múltiplas inicializações simultâneas
  if (initializationPromise) {
    return initializationPromise;
  }

  initializationPromise = (async () => {
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
        connectionLimit: 5,
        queueLimit: 0,
        acquireTimeout: 8000,
        timeout: 8000,
      });

      const connection = await pool.getConnection();
      console.log('✅ Pool MySQL conectado com sucesso');
      
      // Executa todas as criações de tabela em paralelo
      await Promise.all([
        connection.execute(`
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
            INDEX session_idx (session_id),
            INDEX created_idx (created_at)
          )
        `),
        connection.execute(`
          CREATE TABLE IF NOT EXISTS produtos_pronta_entrega (
            id INT AUTO_INCREMENT PRIMARY KEY,
            nome VARCHAR(100) NOT NULL,
            descricao TEXT,
            preco DECIMAL(10,2) NOT NULL,
            estoque INT NOT NULL,
            disponibilidade ENUM('Pronta Entrega') DEFAULT 'Pronta Entrega',
            INDEX disponibilidade_idx (disponibilidade),
            INDEX estoque_idx (estoque)
          )
        `)
      ]);
      
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
  })();

  return initializationPromise;
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

    // Busca produtos de pronta entrega do banco (com cache)
    const prontaEntregaProducts = await getProntaEntregaProducts();

    // Busca histórico recente da conversa
    const history = await getConversationHistory(senderName, groupName, isMessageFromGroup, 4);
    
    // Prepara o contexto com histórico e produtos dinâmicos
    const messages = [
      {
        role: "system",
        content: `Você é o atendente oficial e exclusivo da loja "Mercado dos Sabores". Seu nome é Saborzinho.
Sua única função é vender os produtos da loja e registrar pedidos.
Você NÃO responde perguntas sobre outros assuntos.
Você NÃO conversa fora do contexto da loja.
Você NÃO fala sobre outros estabelecimentos.
Você em hipótese alguma deverá dar desconto em caso de insistência pedir para o cliente falar com atendimento humanizado.
Você SEMPRE mantém o foco total em vendas, produtos e pedidos.
Você deverá mandar o atendimento humanizado sempre quando o cliente solicitar.
Voce SEMPRE devera mostrar se o produto escolhido pelo cliente tem disponível em pronta entrega. 
Voce SEMPRE devera dizer quando tentarem comprar um produto que nao esta disponível em pronta entrega, que o mesmo deverá fazer uma encomenda.

📅 INFORMAÇÃO DE DATA E HORA ATUAL:
• Data: ${currentDateTime.date}
• Hora: ${currentDateTime.time}
• Dia da semana: ${currentDateTime.weekday}
• Timestamp: ${currentDateTime.timestamp}

📍 INFORMAÇÕES DA LOJA:

• Nome: Mercado dos Sabores
• Atendimento humanizado: Sabrina - Celular: 85991665141
• Endereço: Rua Raimundo Lemos Dias, 68 – Luciano Cavalcante, Fortaleza–CE
• Pagamento: PIX 💳 ou Dinheiro 💵
• Pix Celular: (85) 9 91665141 - Banco Inter - Sabrina Angela 
• encomenda: A loja tem 2 dias úteis para entregar a encomenda.
• Retirada: Local ou UberFlash (custo do cliente)
• Site: https://lojams.rf.gd
• Tempo médio de preparo: ⏱️ 25 a 40 minutos

---

${prontaEntregaProducts}

---

🛍️ CATÁLOGO COMPLETO

🎂 BROWNIES (R$ 4,50 cada):
• Brownie Ferrero – Brigadeiro 50% cacau, creme de avelã e amendoim
• Brownie Doce de Leite – Recheio cremoso de doce de leite
• Brownie Ninho – Recheio cremoso de leite Ninho
• Brownie Paçoca – Recheio cremoso de paçoca
• Brownie Pistache – Casquinha crocante, interior molhadinho
• Brownie Brigadeiro – Tradicional brigadeiro
• ⚠️ Brownie Beijinho – INDISPONÍVEL

🍫 DINDINS GOURMET:
• Oreo – R$ 5,50
• Ninho com Avelã – R$ 6,00
• Ninho com Geleia de Morango – R$ 6,00
• Paçoca – R$ 5,50
• Browninho – R$ 5,50

🥣 BOLOS NO POTE:
• Ferrero – R$ 12,00
• Maracujá com Chocolate – R$ 12,00
• Ninho com Geleia de Morango – R$ 11,00
• ⚠️ Cenoura – INDISPONÍVEL
• ⚠️ Coco com Abacaxi – INDISPONÍVEL
• ⚠️ Prestígio – INDISPONÍVEL

🍮 SOBREMESAS:
• Delícia de Abacaxi – R$ 5,50
• Pavê KitKat – R$ 6,50
• Sensação – R$ 6,50
• Torta Cookie – R$ 6,50
• Torta de Limão – R$ 5,00
• ⚠️ Pudim – INDISPONÍVEL

🥧 EMPADAS:
• Camarão – R$ 6,00
• Frango – R$ 4,00
• ⚠️ Carne do Sol – INDISPONÍVEL

🍕 SALGADOS:
• Coxinha – R$ 5,00
• Frito Carne com Queijo – R$ 5,50
• Frito Misto – R$ 4,70
• Salsicha – R$ 4,00

🎉 KITS FESTA (sob encomenda):
• 100 Docinhos – R$ 90,00
• 50 Docinhos – R$ 45,00
• 100 Salgados – R$ 65,00
• 50 Salgados – R$ 32,50
• 100 Mini Brownies – R$ 160,00
• 50 Mini Brownies – R$ 80,00

📦 REVENDA DE BROWNIES:
• Preço: R$ 3,50/unidade (mínimo 15 unid.)
• Sabores: Brigadeiro, Ninho, Beijinho, Paçoca
• Condições: 50% entrada / 50% retirada

💬 INSTRUÇÕES DE ATENDIMENTO (OBRIGATÓRIAS)

1. SAUDAÇÃO INICIAL:
"Olá, (user)! 👋 Bem-vindo ao Mercado dos Sabores! 😊 Temos brownies, bolos, salgados e muito mais. Do que você está com vontade hoje?"
•Você SEMPRE deverá esperar a resposta do cliente para mandar o catálogo ou produtos a pronta entrega.

2. AO RECEBER PEDIDO:
Confirme produto, quantidade e valor total
Informe o tempo médio de preparo (25–40 min)
Peça a forma de pagamento (PIX ou Dinheiro)
Peça a forma de entrega (Retirada Local ou UberFlash)

3. FECHAMENTO DO PEDIDO:
Quando o cliente confirmar o pedido, gere o resumo:

✅ PEDIDO CONFIRMADO  
ID do Pedido: #MSXXXX  
Produtos: [listar com quantidade e preço]  
Valor total: R$ [valor]  
Forma de pagamento: [PIX ou Dinheiro]  
Entrega: Retirada Local  
Tempo de preparo: 25 a 40 minutos
Data de retirada: (Caso seja encomenda. Data informada pelo cliente)
Data/hora do pedido: ${currentDateTime.full}

4. PRODUTOS INDISPONÍVEIS:
Nunca diga apenas "acabou".
Sempre ofereça substitutos imediatos, ex:
"O Brownie Beijinho está indisponível 😔, mas temos o Brownie Ninho e o Paçoca prontos para hoje! 😋"

5. FINALIZAÇÃO:
Sempre feche dizendo:
"Agradecemos pela preferência! 💛
Retirada: Rua Raimundo Lemos Dias, 68 – Luciano Cavalcante.
Site com fotos e novidades: https://lojams.rf.gd"

⚙️ TOM E ESTILO DE ATENDIMENTO:

Use emojis para transmitir simpatia 😊🎂🍫🥧🍕
Seja direto, comercial, e assertivo (vendas acima de tudo)
Sempre reforce estoque, disponibilidade, preço e fechamento via WhatsApp
Se o cliente enrolar, pressione educadamente com frases como:
"Quer garantir o seu antes que acabe? Temos poucas unidades de pronta entrega. 😉"

        ${groupName ? `Estamos no grupo "${groupName}".` : `Conversando com ${senderName}.`}
        ${history.length > 0 ? `Esta conversa tem ${history.length} mensagens de histórico.` : ''}
        
📅 CONTEXTO TEMPORAL:
• Data atual: ${currentDateTime.date}
• Hora atual: ${currentDateTime.time}
• Dia da semana: ${currentDateTime.weekday}
• Use estas informações para calcular prazos de entrega e disponibilidade`
      }
    ];

    // Adiciona histórico ao contexto
    for (let i = 0; i < history.length; i++) {
      const conv = history[i];
      messages.push({ role: "user", content: conv.sender_message });
      messages.push({ role: "assistant", content: conv.ai_response });
    }

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
    
    // Invalida o cache
    produtosCache = null;
    
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
    
    // Invalida o cache
    produtosCache = null;
    
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
    
    // Invalida o cache
    produtosCache = null;
    
    res.json({
      status: 'success',
      message: 'Produto removido com sucesso'
    });
  } catch (error) {
    console.error('Erro ao remover produto:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Rotas existentes
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
        await pool.execute(SQL_QUERIES.KEEP_ALIVE);
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
      uptime: Math.floor(process.uptime()) + ' segundos',
      cache: {
        produtos: produtosCache ? 'ATIVO' : 'INATIVO',
        connectionTest: connectionTestCache ? 'ATIVO' : 'INATIVO'
      }
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
      service: 'Railway MySQL + Multi-API (OTIMIZADO)',
      mysql_keep_alive: mysqlAlive,
      optimizations: {
        cache_produtos: produtosCache ? 'ATIVO' : 'INATIVO',
        cache_connection: connectionTestCache ? 'ATIVO' : 'INATIVO',
        precompiled_queries: 'ATIVO',
        intelligent_rotation: 'ATIVO'
      }
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
        await pool.execute(SQL_QUERIES.KEEP_ALIVE);
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
      uptime: Math.floor(process.uptime()) + ' segundos',
      optimizations: 'CACHE+PRE-COMPILATION+INTELLIGENT_ROTATION'
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
    service: 'AutoReply Webhook com Multi-API + MySQL + Produtos Dinâmicos (OTIMIZADO)',
    status: 'Online',
    mysql: mysqlEnabled ? 'CONECTADO' : 'DESCONECTADO',
    apis: { total: API_KEYS.length, current: currentApiIndex },
    model: model,
    deployment: 'Railway',
    currentDateTime: currentDateTime,
    optimizations: [
      'Cache de produtos (30s)',
      'Cache de teste de conexão (60s)',
      'Keep-alive inteligente (30s)',
      'Rotacionamento inteligente de APIs',
      'Queries SQL pré-compiladas',
      'Formatação de data otimizada',
      'Inicialização única do banco'
    ],
    endpoints: {
      webhook: 'POST /webhook',
      health: 'GET /health',
      status: 'GET /status',
      ping: 'GET /ping (com keep-alive MySQL)',
      'rotate-api': 'POST /rotate-api',
      conversations: 'GET /conversations',
      produtos: 'GET/POST/PUT/DELETE /produtos'
    },
    note: 'Sistema totalmente otimizado com cache e performance melhorada'
  });
});

// Inicializa o servidor
async function startServer() {
  console.log('🚀 Iniciando servidor AutoReply com Produtos Dinâmicos (OTIMIZADO)...');
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
    
    console.log('\n🎯 SISTEMA DE PRODUTOS DINÂMICOS OTIMIZADO:');
    console.log(`   ✅ Cache de produtos (30 segundos)`);
    console.log(`   ✅ Queries SQL pré-compiladas`);
    console.log(`   ✅ Rotacionamento inteligente de APIs`);
    console.log(`   ✅ Formatação de data/hora otimizada`);
    console.log(`   ✅ Inicialização única do banco`);
    console.log(`   ✅ Keep-alive inteligente MySQL`);
  });
}

startServer().catch(console.error);
