const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');

const app = express();
const PORT = process.env.PORT || 3000;

// Middlewares
app.use(cors());
app.use(express.json());

// Inicializar cliente OpenAI
let client = null;

if (process.env.GITHUB_TOKEN) {
  client = new OpenAI({
    baseURL: "https://models.inference.ai.azure.com",
    apiKey: process.env.GITHUB_TOKEN
  });
  console.log('✅ Cliente OpenAI configurado');
} else {
  console.log('⚠️  GITHUB_TOKEN não encontrado - usando modo simulador');
}

// Rota RAIZ - Teste simples
app.get('/', (req, res) => {
  res.json({ 
    message: '🚀 IA Professora de Cálculo Online!',
    status: 'funcionando',
    rotas: {
      teste: '/teste (GET)',
      perguntar: '/perguntar (POST)',
      health: '/health (GET)'
    }
  });
});

// Rota TESTE - Corrigida
app.get('/teste', (req, res) => {
  res.json({
    mensagem: '✅ Rota /teste funcionando perfeitamente!',
    exemplo: 'Envie POST para /perguntar com: {"pergunta": "sua pergunta aqui"}',
    timestamp: new Date().toISOString()
  });
});

// Rota HEALTH
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    serviço: 'IA Professora de Cálculo',
    ia_configurada: !!client,
    timestamp: new Date().toISOString()
  });
});

// Rota principal - PERGUNTAR
app.post('/perguntar', async (req, res) => {
  try {
    const { pergunta } = req.body;

    if (!pergunta) {
      return res.status(400).json({ 
        error: '❌ Por favor, envie uma pergunta no formato: {"pergunta": "sua pergunta"}' 
      });
    }

    console.log(`📚 Pergunta recebida: "${pergunta}"`);

    // Se não há cliente configurado, usar resposta simulada
    if (!client) {
      const respostaSimulada = getRespostaSimulada(pergunta);
      return res.json({
        pergunta: pergunta,
        resposta: respostaSimulada,
        professora: "IA Professora de Cálculo (Modo Simulador)",
        observacao: "GitHub Token não configurado",
        timestamp: new Date().toISOString()
      });
    }

    // Chamar a IA real
    const response = await client.chat.completions.create({
      messages: [
        { 
          role: "system", 
          content: `Você é uma professora de cálculo muito paciente, didática e encorajadora.

PRINCIPAIS TÓPICOS QUE ENSINA:
• Limites e continuidade
• Derivadas e aplicações
• Integrais e teorema fundamental
• Séries e sequências
• Equações diferenciais
• Cálculo multivariável

SEU ESTILO DE ENSINO:
- Explique conceitos passo a passo
- Use analogias e exemplos do mundo real
- Seja positiva e motivadora
- Corrija gentilmente equívocos
- Celebre o aprendizado do aluno

IDENTIFICAÇÃO: Sempre se apresente como "professora de cálculo"` 
        },
        { 
          role: "user", 
          content: pergunta 
        }
      ],
      temperature: 0.7,
      max_tokens: 600,
      model: "gpt-4"
    });

    const resposta = response.choices[0].message.content;

    console.log('✅ Resposta da IA gerada com sucesso');

    res.json({
      pergunta: pergunta,
      resposta: resposta,
      professora: "IA Professora de Cálculo",
      modelo: "GitHub AI",
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Erro na IA:', error.message);
    
    // Resposta de fallback em caso de erro
    const fallbackResponse = {
      pergunta: req.body.pergunta,
      resposta: getRespostaSimulada(req.body.pergunta),
      professora: "IA Professora de Cálculo (Modo de Emergência)",
      erro: error.message,
      timestamp: new Date().toISOString()
    };

    res.json(fallbackResponse);
  }
});

// Função para respostas simuladas (fallback)
function getRespostaSimulada(pergunta) {
  const lowerPergunta = pergunta.toLowerCase();
  
  if (lowerPergunta.includes('derivada') || lowerPergunta.includes('derivar')) {
    return `Olá! Sou sua professora de cálculo! 📚✨

Sobre derivadas: imagine que você está dirigindo um carro. A derivada da posição em relação ao tempo é a velocidade! Ela nos diz a taxa de variação instantânea.

A derivada de f(x) = x² é f'(x) = 2x. Isso significa que a cada ponto da parábola, a inclinação da reta tangente é 2x.

Quer que eu explique mais algum conceito específico sobre derivadas? 😊`;
  }
  else if (lowerPergunta.includes('integral') || lowerPergunta.includes('integrar')) {
    return `Que ótima pergunta! 💡

Integrais são como o "oposto" das derivadas. Enquanto a derivada nos dá a taxa de variação, a integral acumula valores.

Pense em calcular a área sob uma curva! A integral nos ajuda a somar infinitas fatias infinitesimais.

A integral de 2x dx é x² + C (não esqueça da constante de integração C!).

Vamos praticar juntos? 🎯`;
  }
  else if (lowerPergunta.includes('limite')) {
    return `Excelente pergunta sobre limites! 📈

Limites nos ajudam a entender o comportamento de funções quando nos aproximamos de um ponto, mesmo que não possamos chegar exatamente nele.

Por exemplo: lim(x→2) de (x²-4)/(x-2) = 4, mesmo que a função não esteja definida em x=2.

É a base de todo o cálculo! Quer explorar mais? 😄`;
  }
  else if (lowerPergunta.includes('oi') || lowerPergunta.includes('olá')) {
    return `Olá! 👋 Sou sua professora de cálculo! 

Estou aqui para ajudar você a dominar limites, derivadas, integrais e todos os conceitos do cálculo.

Em que posso ajudar você hoje? Tem alguma dúvida específica? 📚💫`;
  }
  else {
    return `Olá! Sou sua professora de cálculo! 🎓

Sobre "${pergunta}" - este é um ótimo tópico para explorarmos juntos!

Posso explicar sobre:
• 📊 Limites e continuidade
• 📈 Derivadas e aplicações  
• 📉 Integrais e áreas
• 🔄 Teorema Fundamental do Cálculo
• 🎯 Equações Diferenciais

Qual aspecto você gostaria de explorar? Estou aqui para ajudar! 😊`;
  }
}

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`\n🎓 IA PROFESSORA DE CÁLCULO INICIADA!`);
  console.log(`📍 Porta: ${PORT}`);
  console.log(`🌐 URL Local: http://localhost:${PORT}`);
  console.log(`🌐 URL Remota: https://meu-bot-api-9dz3.onrender.com`);
  console.log(`\n📚 ROTAS DISPONÍVEIS:`);
  console.log(`   GET  /       - Página inicial`);
  console.log(`   GET  /teste  - Teste da API`);
  console.log(`   GET  /health - Status do serviço`);
  console.log(`   POST /perguntar - Fazer perguntas à IA`);
  console.log(`\n🔧 Status IA: ${client ? 'CONFIGURADA ✅' : 'MODO SIMULADOR ⚠️'}`);
});
