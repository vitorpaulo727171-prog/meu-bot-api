const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Middlewares
app.use(cors());
app.use(express.json());

// Rota principal
app.get('/', (req, res) => {
  res.json({ 
    message: 'API do AutoReply funcionando!',
    status: 'online'
  });
});

// Rota do webhook (POST)
app.post('/webhook', (req, res) => {
  console.log('Mensagem recebida:', req.body);
  
  const { senderMessage, senderName, isMessageFromGroup, groupName } = req.body;
  
  // Evitar responder em grupos se não quiser
  if (isMessageFromGroup) {
    return res.json({
      data: [{ message: "" }] // Resposta vazia para grupos
    });
  }
  
  // Lógica de resposta para mensagens privadas
  let resposta = "";
  
  if (senderMessage.toLowerCase().includes('oi')) {
    resposta = `Olá ${senderName}! Como posso ajudar?`;
  } else if (senderMessage.toLowerCase().includes('horário')) {
    resposta = `Horário atual: ${new Date().toLocaleTimeString('pt-BR')}`;
  } else {
    resposta = `Você disse: ${senderMessage}`;
  }
  
  const response = {
    data: [{ message: resposta }]
  };
  
  res.json(response);
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});
