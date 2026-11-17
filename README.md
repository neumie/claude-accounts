# Claude Accounts

Chrome rozšíření pro práci s několika claude.ai účty. Každý účet má vlastní Chrome profil. Když otevřeš odkaz na artifact v profilu, jehož účet ho neotevře, rozšíření ho otevře v profilu, který to umí.

- Rozšíření neukládá žádné cookies ani session, přihlašuješ se normálně v každém profilu.
- Popup ukazuje účty a jedním klikem otevře claude.ai v profilu daného účtu.
- Režim pro odkazy na artifacty: **Auto** (přesune sám), **Ask** (nejdřív se zeptá), **Off**.

Proč takhle a ne prohazováním cookies: `docs/plan.md`, sekce 0.

## Instalace (jednou)

Potřebuješ Node 23.6 nebo novější (`node --version`).

```sh
cd ~/Documents/code/neumie/claude-accounts
npm ci --ignore-scripts
npm run build
npm run install-host
```

`install-host` zaregistruje lokálního pomocníka do Chrome. Zapíše dva soubory:
- `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/dev.neumie.claude_accounts.json`
- `~/Library/Application Support/claude-accounts/host.sh`

Odinstaluješ ho přes `npm run uninstall-host`.

## Pro každý účet

1. V Chrome přes menu profilů vytvoř profil a pojmenuj ho podle účtu (`ucet1`, `ucet2`, `ucet3`).
2. V tom profilu otevři `chrome://extensions`, zapni **Developer mode**, dej **Load unpacked** a vyber složku `dist/` z tohohle repa.
3. Přihlas se na claude.ai. Účet se v popupu objeví sám.

Na claude.ai se nikdy neodhlašuj. Odhlášení ruší session na serveru. Když účet nepotřebuješ, prostě zavři okno profilu.

## Vývoj

```sh
npm run check   # tsc + testy + build
```

- `src/`: rozšíření (Solid + rollup jako Helm). `background.ts` mluví s pomocníkem, `content.ts` běží na claude.ai, `popup/` je UI.
- `host/`: native messaging host (Node, TypeScript spouštěný přímo). Sdílený stav je v `~/Library/Application Support/claude-accounts/state.json` a obsahuje jen e-maily, orgy, UUID artifactů a jména profilů.
- Po změně v `src/` spusť `npm run build` a v `chrome://extensions` dej u rozšíření reload, v každém profilu zvlášť.
