# Google Ads MCP — setup e uso

Servidor MCP oficial do Google (`googleads/google-ads-mcp`) registrado em
`.mcp.json` como `google-ads-mcp`. É uma ferramenta de dev — roda local via
`pipx`, não é implantada com o site. Dá acesso **somente leitura** à conta
Google Ads da UP2CLOUD para keyword research e análise de campanhas/ranking
pagas direto no Claude Code.

Não confundir com o servidor MCP já publicado em `functions/connect.js`
(`GET/POST /connect`) — esse é o servidor MCP remoto do próprio site
(read-only sobre dados institucionais: serviços, contato, blog), roda em
Cloudflare Pages Functions e não tem relação com o Google Ads.

## Requisitos

Conta de developer no [Google Ads API Center](https://ads.google.com/aw/apicenter):

- **Developer token** (22 caracteres) — aprovado para acesso à conta
- **Google Cloud Project ID** com a Google Ads API habilitada
- **OAuth Client ID/Secret** (OAuth 2.0 Desktop/Web) do mesmo projeto GCP
- `pipx` instalado localmente (`pip install --user pipx`)

## Configuração

Credenciais **não** ficam no `.mcp.json` nem em nenhum arquivo commitado.
Exporte antes de abrir o Claude Code:

```bash
export GOOGLE_PROJECT_ID="..."
export GOOGLE_ADS_DEVELOPER_TOKEN="..."
export GOOGLE_ADS_MCP_OAUTH_CLIENT_ID="..."
export GOOGLE_ADS_MCP_OAUTH_CLIENT_SECRET="..."
```

O `.mcp.json` referencia essas variáveis via `${VAR}` — sem valor exportado,
o servidor falha ao iniciar (comportamento esperado, não é bug).

Primeiro uso dispara o OAuth consent flow do Google no browser para gerar o
refresh token.

**Erro `pipx needs uv>=X, but uv reports Y`**: acontece quando o `uv` instalado
na máquina é mais antigo que o exigido pelo backend padrão do pipx. Contornar
com `pipx run --backend pip --spec ...` (mesmo pacote, troca só o backend de
resolução) ou atualizar o `uv` (`uv self update`). Testado e confirmado
funcional com `--backend pip`.

## Tools expostas (read-only)

- `list_accessible_customers` — lista customer IDs/contas acessíveis
- `search` — consultas GAQL (Google Ads Query Language) para métricas,
  orçamento e status de campanha
- `get_resource_metadata` — metadados de tipos de recurso (campaigns, ad
  groups, keywords, etc.)

Não permite pausar campanha, ajustar lance ou criar asset — só leitura.

## Como isso ajuda ranking/Ads da UP2CLOUD

1. **Keyword research** via `search` (GAQL sobre `keyword_view` /
   `search_term_view`) para achar termos de busca com volume/CPC relevantes
   a Platform Engineering, FinOps e DevOps consulting — usar como insumo
   para títulos/meta description de posts novos em `blog/` (via
   `node scripts/add-post.js`) e para o copy de campanhas Ads.
2. **Auditoria de campanha** via `search` sobre `campaign` / `ad_group_ad` —
   identificar campanhas com CTR ou Quality Score baixos antes de decidir
   onde investir budget.
3. Ativação do conversion tracking de Ads no site já está pronta em
   `index.html` (`GOOGLE_ADS_ID`, guardado por `/^AW-/`) e no workflow
   (`.github/workflows/deploy-pages.yml`, variável `GOOGLE_ADS_ID`) — só
   falta preencher o Conversion ID real (`ads.google.com` → Tools →
   Conversions) no `env:` do workflow. Idem para
   `GOOGLE_SITE_VERIFICATION_ID` (Search Console), que cobre o SEO orgânico.
4. Qualquer mudança de conta (pausar campanha, ajustar lance) continua
   manual no Google Ads UI — o MCP aqui é só leitura/diagnóstico.
