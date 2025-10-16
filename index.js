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

// Função para gerar ID do pedido
function generateOrderId() {
  const timestamp = Date.now().toString().slice(-6);
  const random = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
  return `MS${timestamp}${random}`;
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
      productsString += `🎂 ${product.nome}\n`;
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

// Função para extrair produtos do texto
function extrairProdutosDoTexto(textoProdutos) {
  const produtos = [];
  const linhas = textoProdutos.split('\n').filter(linha => linha.trim());
  
  for (const linha of linhas) {
    // Padrões comuns: "2x Brownie Ferrero", "1x Dindin Oreo R$ 5,50", etc.
    const matchQuantidade = linha.match(/(\d+)x\s+([^]+?)(?:\s*R\$\s*([\d,]+))?/i);
    
    if (matchQuantidade) {
      const quantidade = parseInt(matchQuantidade[1]);
      const nome = matchQuantidade[2].trim();
      const precoUnitario = matchQuantidade[3] ? parseFloat(matchQuantidade[3].replace(',', '.')) : 0;
      
      produtos.push({
        nome: nome,
        quantidade: quantidade,
        preco_unitario: precoUnitario,
        subtotal: precoUnitario * quantidade
      });
    } else {
      // Tentar outros padrões
      const matchSemQuantidade = linha.match(/^[^-]*?([^]+?)\s*R\$\s*([\d,]+)/i);
      if (matchSemQuantidade) {
        produtos.push({
          nome: matchSemQuantidade[1].trim(),
          quantidade: 1,
          preco_unitario: parseFloat(matchSemQuantidade[2].replace(',', '.')),
          subtotal: parseFloat(matchSemQuantidade[2].replace(',', '.'))
        });
      }
    }
  }
  
  return produtos;
}

// Função para processar pedido - VERSÃO MELHORADA
async function processarPedido(aiResponse, sessionId, senderName, groupName, isMessageFromGroup) {
  try {
    // Padrões para detectar pedido confirmado - mais flexível
    const padraoPedido = /✅ PEDIDO CONFIRMADO|PEDIDO CONFIRMADO|pedido confirmado|✅ Pedido Confirmado/i;
    
    if (!padraoPedido.test(aiResponse)) {
      return null; // Não é um pedido confirmado
    }

    console.log('🛒 Detectando pedido na resposta da IA...');

    // Extrair ID do pedido
    const idMatch = aiResponse.match(/#MS(\w+)|ID.*?(\w+)$/mi);
    const pedidoId = idMatch ? (idMatch[1] || idMatch[2] || generateOrderId()) : generateOrderId();

    // Tentar extrair informações específicas
    let produtosTexto = '';
    let valorTotal = 0;
    let formaPagamento = 'PIX';
    let formaEntrega = 'Retirada Local';
    let observacoes = '';

    // Extrair produtos - método mais flexível
    const produtosSection = aiResponse.split('Produtos:')[1];
    if (produtosSection) {
      const endSection = produtosSection.split('Valor total')[0] || produtosSection.split('Forma de pagamento')[0] || produtosSection;
      produtosTexto = endSection.trim();
    }

    // Extrair valor total
    const valorMatch = aiResponse.match(/Valor total:\s*R\$\s*([\d,\.]+)/i) || 
                      aiResponse.match(/Total:\s*R\$\s*([\d,\.]+)/i);
    if (valorMatch) {
      valorTotal = parseFloat(valorMatch[1].replace('.', '').replace(',', '.'));
    }

    // Extrair forma de pagamento
    const pagamentoMatch = aiResponse.match(/Forma de pagamento:\s*([^\n]+)/i) || 
                          aiResponse.match(/Pagamento:\s*([^\n]+)/i);
    if (pagamentoMatch) {
      formaPagamento = pagamentoMatch[1].trim();
    }

    // Extrair forma de entrega
    const entregaMatch = aiResponse.match(/Entrega:\s*([^\n]+)/i);
    if (entregaMatch) {
      formaEntrega = entregaMatch[1].trim();
    }

    // Extrair observações
    const obsMatch = aiResponse.match(/Observações:\s*([^]*?)(?=$|\n\n)/i);
    if (obsMatch) {
      observacoes = obsMatch[1].trim();
    }

    // Processar produtos individuais
    const produtos = produtosTexto ? extrairProdutosDoTexto(produtosTexto) : [];

    // Se não conseguiu extrair produtos, criar um registro básico
    if (produtos.length === 0) {
      console.log('⚠️  Não foi possível extrair produtos específicos, criando registro básico do pedido');
      produtos.push({
        nome: 'Pedido confirmado (detalhes na mensagem completa)',
        quantidade: 1,
        preco_unitario: valorTotal > 0 ? valorTotal : 0,
        subtotal: valorTotal > 0 ? valorTotal : 0
      });
    }

    // Calcular valor total se não foi extraído
    if (valorTotal === 0 && produtos.length > 0) {
      valorTotal = produtos.reduce((total, produto) => total + produto.subtotal, 0);
    }

    const pedidoData = {
      session_id: sessionId,
      sender_name: senderName,
      group_name: groupName || '',
      is_group_message: isMessageFromGroup ? 1 : 0,
      produtos_json: JSON.stringify(produtos),
      valor_total: valorTotal,
      forma_pagamento: formaPagamento,
      forma_entrega: formaEntrega,
      observacoes: observacoes,
      status: 'confirmado',
      resposta_completa: aiResponse, // Armazena a mensagem completa
      pedido_id: pedidoId // Armazena o ID do pedido
    };

    console.log(`🛒 Pedido processado: ${produtos.length} produtos, R$ ${valorTotal}, ID: ${pedidoId}`);
    return pedidoData;

  } catch (error) {
    console.error('❌ Erro ao processar pedido:', error);
    return null;
  }
}

// Função para salvar pedido no banco - VERSÃO ATUALIZADA
async function salvarPedido(pedidoData) {
  if (!mysqlEnabled || !pool) {
    console.log('⚠️  MySQL não disponível, pulando salvamento do pedido');
    return null;
  }

  try {
    console.log(`💾 Salvando pedido no banco...`);
    
    const [result] = await pool.execute(
      `INSERT INTO pedidos 
       (session_id, sender_name, group_name, is_group_message, produtos_json, valor_total, 
        forma_pagamento, forma_entrega, observacoes, status, resposta_completa, pedido_id) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        pedidoData.session_id,
        pedidoData.sender_name,
        pedidoData.group_name,
        pedidoData.is_group_message,
        pedidoData.produtos_json,
        pedidoData.valor_total,
        pedidoData.forma_pagamento,
        pedidoData.forma_entrega,
        pedidoData.observacoes,
        pedidoData.status,
        pedidoData.resposta_completa,
        pedidoData.pedido_id
      ]
    );
    
    const pedidoId = result.insertId;
    console.log(`✅ Pedido salvo - ID: ${pedidoId}, Código: ${pedidoData.pedido_id}`);
    
    // Atualizar estoque dos produtos apenas se conseguiu extrair produtos específicos
    try {
      const produtos = JSON.parse(pedidoData.produtos_json);
      if (produtos.length > 0 && produtos[0].nome !== 'Pedido confirmado (detalhes na mensagem completa)') {
        await atualizarEstoquePedido(produtos);
      }
    } catch (estoqueError) {
      console.log('⚠️  Não foi possível atualizar estoque, mas o pedido foi salvo');
    }
    
    return { id: pedidoId, codigo: pedidoData.pedido_id };
    
  } catch (error) {
    console.error('❌ Erro ao salvar pedido:', error.message);
    return null;
  }
}

// Função para atualizar estoque
async function atualizarEstoquePedido(produtos) {
  try {
    for (const produto of produtos) {
      // Buscar produto no banco pelo nome (aproximado)
      const [rows] = await pool.execute(
        `SELECT id, estoque FROM produtos_pronta_entrega 
         WHERE nome LIKE ? AND estoque > 0`,
        [`%${produto.nome}%`]
      );
      
      if (rows.length > 0) {
        const produtoDb = rows[0];
        const novoEstoque = produtoDb.estoque - produto.quantidade;
        
        await pool.execute(
          `UPDATE produtos_pronta_entrega SET estoque = ? WHERE id = ?`,
          [Math.max(0, novoEstoque), produtoDb.id]
        );
        
        console.log(`📦 Estoque atualizado: ${produto.nome} - ${produtoDb.estoque} → ${novoEstoque}`);
      }
    }
  } catch (error) {
    console.error('❌ Erro ao atualizar estoque:', error.message);
  }
}

// Função para enviar notificação de novo pedido
async function enviarNotificacaoPedido(pedidoInfo, pedidoData) {
  try {
    const produtos = JSON.parse(pedidoData.produtos_json);
    const mensagemNotificacao = `
🆕 NOVO PEDIDO #${pedidoInfo.codigo}
👤 Cliente: ${pedidoData.sender_name}
📦 ${produtos.length} itens
💰 Total: R$ ${pedidoData.valor_total}
💳 Pagamento: ${pedidoData.forma_pagamento}
🚚 Entrega: ${pedidoData.forma_entrega}
⏰ Horário: ${getCurrentDateTime().full}
📝 Status: ${pedidoData.status}
    `.trim();

    console.log('🔔 Notificação de pedido:\n', mensagemNotificacao);
    console.log('📄 Mensagem completa armazenada no banco de dados');
    
  } catch (error) {
    console.error('❌ Erro ao enviar notificação:', error);
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
    
    // Cria a tabela pedidos se não existir - VERSÃO ATUALIZADA
    console.log('🔄 Verificando/Criando tabela pedidos...');
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS pedidos (
        id INT AUTO_INCREMENT PRIMARY KEY,
        pedido_id VARCHAR(50) NOT NULL,
        session_id VARCHAR(255) NOT NULL,
        sender_name VARCHAR(255) NOT NULL,
        group_name VARCHAR(255),
        is_group_message BOOLEAN DEFAULT FALSE,
        produtos_json JSON NOT NULL,
        valor_total DECIMAL(10,2) NOT NULL,
        forma_pagamento ENUM('PIX', 'Dinheiro') DEFAULT 'PIX',
        forma_entrega ENUM('Retirada Local', 'UberFlash') DEFAULT 'Retirada Local',
        status ENUM('confirmado', 'preparando', 'pronto', 'entregue', 'cancelado') DEFAULT 'confirmado',
        observacoes TEXT,
        resposta_completa TEXT NOT NULL,
        data_retirada DATETIME,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
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
ID do Pedido: #MS${generateOrderId()}  
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

    // 🛒 Processar pedido se detectado - MÉTODO MELHORADO
    const sessionId = generateSessionId(senderName, groupName, isMessageFromGroup);
    const pedidoData = await processarPedido(aiResponse, sessionId, senderName, groupName, isMessageFromGroup);

    if (pedidoData) {
      const pedidoInfo = await salvarPedido(pedidoData);
      if (pedidoInfo) {
        console.log(`🎉 Pedido #${pedidoInfo.id} registrado com sucesso! Código: ${pedidoInfo.codigo}`);
        
        // Enviar notificação (opcional)
        await enviarNotificacaoPedido(pedidoInfo, pedidoData);
      }
    }

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

// Rotas para pedidos - VERSÃO ATUALIZADA
// Rota de diagnóstico do banco de dados
app.get('/diagnostico', async (req, res) => {
  try {
    const diagnostic = {
      mysql_enabled: mysqlEnabled,
      pool_available: !!pool,
      current_time: getCurrentDateTime(),
      api_keys: API_KEYS.length
    };

    if (mysqlEnabled && pool) {
      try {
        // Testar conexão
        const [testResult] = await pool.execute('SELECT 1 as test');
        diagnostic.connection_test = 'OK';
        
        // Contar registros nas tabelas
        const [pedidosCount] = await pool.execute('SELECT COUNT(*) as total FROM pedidos');
        const [conversationsCount] = await pool.execute('SELECT COUNT(*) as total FROM conversations');
        const [produtosCount] = await pool.execute('SELECT COUNT(*) as total FROM produtos_pronta_entrega');
        
        diagnostic.table_counts = {
          pedidos: pedidosCount[0].total,
          conversations: conversationsCount[0].total,
          produtos: produtosCount[0].total
        };

        // Verificar estrutura da tabela pedidos
        const [columns] = await pool.execute("SHOW COLUMNS FROM pedidos");
        diagnostic.pedidos_columns = columns.map(col => ({
          name: col.Field,
          type: col.Type,
          null: col.Null,
          key: col.Key
        }));

      } catch (dbError) {
        diagnostic.connection_test = 'ERROR: ' + dbError.message;
      }
    }

    res.json({
      status: 'success',
      diagnostic: diagnostic
    });

  } catch (error) {
    console.error('Erro no diagnóstico:', error);
    res.status(500).json({ 
      error: 'Erro no diagnóstico',
      details: error.message 
    });
  }
});

// Buscar pedido por ID específico
app.get('/pedidos/:id', async (req, res) => {
  if (!mysqlEnabled || !pool) {
    return res.status(500).json({ error: 'MySQL não disponível' });
  }

  try {
    const { id } = req.params;
    
    const [rows] = await pool.execute(`
      SELECT *, DATE_FORMAT(created_at, '%d/%m/%Y %H:%i') as data_pedido 
      FROM pedidos 
      WHERE id = ? OR pedido_id = ?
    `, [id, id]);
    
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Pedido não encontrado' });
    }
    
    const pedido = {
      ...rows[0],
      produtos_json: JSON.parse(rows[0].produtos_json)
    };
    
    res.json({
      status: 'success',
      data: pedido
    });
  } catch (error) {
    console.error('Erro ao buscar pedido:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Atualizar status do pedido
app.put('/pedidos/:id/status', async (req, res) => {
  if (!mysqlEnabled || !pool) {
    return res.status(500).json({ error: 'MySQL não disponível' });
  }

  try {
    const { id } = req.params;
    const { status } = req.body;
    
    await pool.execute(
      'UPDATE pedidos SET status = ? WHERE id = ? OR pedido_id = ?',
      [status, id, id]
    );
    
    res.json({
      status: 'success',
      message: 'Status do pedido atualizado'
    });
  } catch (error) {
    console.error('Erro ao atualizar pedido:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Estatísticas de pedidos
app.get('/pedidos/estatisticas', async (req, res) => {
  if (!mysqlEnabled || !pool) {
    return res.status(500).json({ error: 'MySQL não disponível' });
  }

  try {
    const [total] = await pool.execute('SELECT COUNT(*) as total FROM pedidos');
    const [hoje] = await pool.execute(`
      SELECT COUNT(*) as hoje FROM pedidos 
      WHERE DATE(created_at) = CURDATE()
    `);
    const [revenue] = await pool.execute('SELECT SUM(valor_total) as revenue FROM pedidos');
    const [statusCounts] = await pool.execute(`
      SELECT status, COUNT(*) as count FROM pedidos GROUP BY status
    `);
    
    res.json({
      status: 'success',
      data: {
        total_pedidos: total[0].total,
        pedidos_hoje: hoje[0].hoje,
        faturamento_total: revenue[0].revenue || 0,
        status: statusCounts
      }
    });
  } catch (error) {
    console.error('Erro ao buscar estatísticas:', error);
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
      service: 'Railway MySQL + Multi-API + Sistema de Pedidos Aprimorado',
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
    service: 'AutoReply Webhook com Multi-API + MySQL + Sistema de Pedidos Aprimorado',
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
      produtos: 'GET/POST/PUT/DELETE /produtos',
      pedidos: 'GET /pedidos',
      'pedido-especifico': 'GET /pedidos/:id',
      'pedidos-estatisticas': 'GET /pedidos/estatisticas',
      'atualizar-status': 'PUT /pedidos/:id/status'
    },
    features: {
      'multi-api': 'Rotacionamento automático de APIs',
      'mysql': 'Banco de dados para conversas e produtos',
      'produtos-dinamicos': 'Gerenciamento de estoque em tempo real',
      'sistema-pedidos': 'Registro automático de pedidos aprimorado',
      'resposta-completa': 'Armazena mensagem completa da IA',
      'id-pedido': 'Gera e armazena ID único do pedido',
      'extracao-flexivel': 'Extrai dados mesmo com variações no texto'
    },
    note: 'Sistema aprimorado com armazenamento completo da resposta da IA'
  });
});

// Inicializa o servidor
async function startServer() {
  console.log('🚀 Iniciando servidor AutoReply com Sistema de Pedidos Aprimorado...');
  console.log(`🔑 ${API_KEYS.length} chaves API configuradas`);
  console.log(`🤖 Modelo: ${model}`);
  
  await initializeDatabase();
  
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    const currentDateTime = getCurrentDateTime();
    console.log(`🎉 Servidor rodando na porta ${PORT}`);
    console.log(`🌐 Webhook: POST /webhook`);
    console.log(`🛍️  Gerenciar produtos: GET/POST/PUT/DELETE /produtos`);
    console.log(`📦 Gerenciar pedidos: GET /pedidos`);
    console.log(`🔍 Buscar pedido específico: GET /pedidos/:id`);
    console.log(`📊 Estatísticas: GET /pedidos/estatisticas`);
    console.log(`🗃️  MySQL: ${mysqlEnabled ? '✅ CONECTADO' : '❌ DESCONECTADO'}`);
    console.log(`🔋 Keep-alive MySQL: ✅ ATIVO via rota /ping`);
    console.log(`📅 Data/Hora do servidor: ${currentDateTime.full}`);
    
    console.log('\n🎯 SISTEMA DE PEDIDOS APRIMORADO:');
    console.log(`   ✅ Armazenamento da mensagem completa da IA`);
    console.log(`   ✅ Geração automática de ID do pedido`);
    console.log(`   ✅ Extração flexível de dados do pedido`);
    console.log(`   ✅ Fallback quando não consegue extrair produtos`);
    console.log(`   ✅ Busca de pedido por ID ou código`);
    console.log(`   ✅ Estatísticas detalhadas por status`);
  });
}

startServer().catch(console.error);
