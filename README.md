# Claude Accounts

Chrome rozšíření pro přepínání mezi claude.ai účty v jednom okně.

- **Popup:** seznam uložených účtů. Klik přepne účet a claude.ai taby se znovu načtou pod novým účtem.
- **Artifacty:** když otevřeš artifact, který aktivní účet neotevře, rozšíření v tichosti zjistí, který z uložených účtů ho otevře, a přepne na něj. Režimy **Auto**, **Ask** (nejdřív se zeptá) a **Off**.
- V celém prohlížeči je vždy aktivní jen jeden účet.

Jak to funguje uvnitř a jaká to má rizika: `docs/plan.md`.

## Instalace

Potřebuješ Node 23.6 nebo novější (`node --version`).

```sh
cd ~/Documents/code/neumie/claude-accounts
npm ci --ignore-scripts
npm run build
```

V Chrome otevři `chrome://extensions`, zapni **Developer mode**, dej **Load unpacked** a vyber složku `dist/`.

## První použití

1. Přihlas se na claude.ai prvním účtem. V popupu dej **Save**.
2. Dej **Add account**. Rozšíření si aktuální účet nechá a otevře přihlášení. Přihlas se dalším účtem, uloží se sám.
3. Bod 2 zopakuj pro třetí účet.

**Na claude.ai se nikdy neodhlašuj.** Odhlášení ruší session na serveru a uložený účet by přestal fungovat. Na další účet se dostaneš přes **Add account**, ne přes Log out.

Když u účtu uvidíš „Session expired“, klikni na něj a přihlas se znovu.

## Bezpečnost

- Uložené session jsou přihlašovací údaje. Leží jen v `chrome.storage.local` tohoto profilu, nesynchronizují se a nikam se neposílají. Číst je smí jen samotné rozšíření, ne stránky ani content scripty.
- Na disku jsou nešifrované, stejně jako jiná data rozšíření. Kdo má přístup k tvému uživatelskému účtu na Macu, může se k nim dostat.
- Rozšíření potřebuje jen `cookies`, `storage` a `declarativeNetRequestWithHostAccess` a pracuje jen s `https://claude.ai`.

## Vývoj

```sh
npm run check   # tsc + testy + build
```

- `src/background.ts` a `src/bg/`: ukládání účtů, přepínání (`bg/switch.ts`), tichá kontrola přístupu (`bg/claude.ts`).
- `src/content.ts`: běží na claude.ai. Po přepnutí vyčistí stav stránky, hlásí přihlášený účet a kontroluje artifacty.
- `src/popup/`: UI (Solid jako Helm).
- Po změně spusť `npm run build` a v `chrome://extensions` dej u rozšíření reload.
