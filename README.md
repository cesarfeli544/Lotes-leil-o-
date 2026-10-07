# Leilão Inteligente — MVP

Sistema web responsivo para analisar lotes de leilão, pesquisar preços médios de mercado na web, calcular preço de revenda com taxa de cartão em 6x e manter histórico.

## O que já está implementado
- Sem login.
- Acesso pelo navegador no celular/computador quando hospedado.
- Lote numerado automaticamente.
- Data automática.
- Lista colada em bloco único; aceita quantidade no início (`2x`, `2`, etc.).
- Pesquisa de mercado via OpenAI Responses API com web search.
- Média/referência de mercado, confiança e fontes.
- Taxa do leilão padrão 10%.
- Desconto sobre mercado padrão 30%.
- Taxa cartão 6x padrão 6%.
- Frete, outros custos e margem de segurança editáveis.
- Custo do lote distribuído igualmente por unidade, conforme combinado.
- Preço de revenda já calculado para absorver a taxa do cartão.
- Histórico persistente em SQLite.

## Rodar localmente
1. Instale Node.js 20+.
2. `npm install`
3. Copie `.env.example` para `.env` e coloque sua `OPENAI_API_KEY`.
4. `npm start`
5. Abra `http://localhost:3000`.

## Colocar na internet
O app precisa de um servidor Node com armazenamento persistente para o SQLite. Para uso em vários aparelhos, hospede-o em um serviço que mantenha o disco persistente ou troque o SQLite por PostgreSQL/Supabase. A chave da API deve ficar somente no servidor, nunca no navegador.

## Observação
A pesquisa de mercado é uma referência, não garantia de preço de venda. O sistema marca a confiança para ajudar a revisar resultados fracos.
