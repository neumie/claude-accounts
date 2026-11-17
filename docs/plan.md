# Claude accounts: plán

Chrome rozšíření (MV3) pro přepínání mezi Jakubovými claude.ai účty.

1. **Auto:** otevřeš odkaz na artifact, který aktuální účet neotevře → rozšíření přepne na účet, který ho otevře, a stránku znovu načte.
2. **Ručně:** popup se seznamem účtů (e-mail + org), přepnutí jedním klikem, je vidět, který účet je aktivní.

Stav k 17. 11. 2026: postavená **varianta A** (jedno okno, výměna cookies), viz sekce 0a. Návod je v `README.md`. Testy, typecheck a build procházejí. Jakub 17. 11. 2026 živě ověřil ruční přepínání i automatické přepnutí na soukromý artifact jiného účtu.

**Účty** (od dispatchera, stejné jako v Okena AI proxy poolu; ve veřejném repu jsou skutečné e-maily nahrazené zástupnými `ucetN@example.com`):

| E-mail | Orgy | Poznámka |
|---|---|---|
| `ucet1@example.com` | ? | je na něm i Claude Code CLI |
| `ucet2@example.com` | ? | |
| `ucet3@example.com` | ? (zjistí `/api/account` při uložení) | |

Důsledky:
- Jsou to **tři různé e-maily** → přepínání mezi nimi claude.ai samo neumí, rozšíření je potřeba pro všechny tři. Orgy pod každým e-mailem řeší claude.ai samo.
- Claude Code jede přes proxy pool, takže artifact z Claude Code může patřit **kterémukoli** ze tří účtů [odhad]. Heuristika „nejdřív ucet1“ je proto slabá; víc váží cache a tichý probe (otázka 7). Lepší zdroj by byl záznam z Okena proxy, který účet obsloužil session, jež artifact publikovala (otázka 10).
- Všechny tři účty používá i proxy → v žádném z nich nikdy „Log out of all sessions“ a rozšíření nesmí volat `/logout`.
- Avatary ve variantách UI: iniciála z lokální části e-mailu (`U1`, `U2`, `U3`), protože doména je u všech stejná. Názvy orgů ve variantách jsou jen ilustrační.

---

## 0a. Změna: varianta A (17. 11. 2026, později téhož dne)

Jakub nechce přepínat mezi okny Chrome (B), chce jedno okno. Staví se proto **A**: výměna cookies v jednom profilu podle sekce 2. Kód B zůstává v gitu (commit `c945f65`) jako záloha pro případ, že by DBSC výměnu zablokovalo.

Rozhodnutí pro A:
- **Ukládání účtu:** explicitně přes „Save“, nebo automaticky po „Add account“. Snapshot se průběžně obnovuje, protože session rotují. Vlastník session se vždycky ověřuje přes `/api/account`.
- **Co se prohazuje:** všechny claude.ai cookies kromě zařízení a Cloudflare (`anthropic-device-id`, `cf_*`, `__cf_bm`, `_cfuvid`). Stejně to dělá [WZ], který podle autora funguje.
- **Proti „involuntary logout“** jsou tři pojistky:
  - zaparkování všech claude.ai tabů;
  - vyčištění stavu stránky při `document_start` přes marker cookie, mimo úložiště zařízení;
  - DNR blokace logout požadavků během přepnutí a 30 s po něm.
- **Auto-switch pro artifacty:**
  1. nejdřív tichá kontrola ostatních účtů (DNR nastaví Cookie jen pro jeden vlastní request rozšíření);
  2. když nejde, viditelné zkoušení účtů jeden po druhém;
  3. když artifact neotevře nikdo, návrat na původní účet a banner.
- **Šifrování heslem:** ne. Session leží v `chrome.storage.local` s přístupem jen pro rozšíření. Riziko je popsané v README.
- **Pojistky přepínání** (po nezávislé kontrole kódu):
  - Po dobu přepnutí se blokuje každé načtení claude.ai stránky.
  - Tab, který se nedá zaparkovat (dialog „Leave site?“), přepnutí zastaví dřív, než se cokoli změní.
  - Odcházející session se před výměnou vždycky uloží, a to i neuložený účet. Když claude.ai neodpoví, nic se nemění.
  - Přepínání běží vždy jen jedno.
  - Rozpracované přepnutí si service worker zapisuje do deníku. Když spadne, po restartu ho dokončí nebo vrátí.
  - Taby obnovené po přepnutí samy nepřepínají, aby se dva artifacty různých účtů nepřetahovaly.
  - Neúspěšné přepnutí vrátí taby na původní URL.
  - Session se ukládají, jen když Chrome dovolí zamknout úložiště jen pro rozšíření. Jinak se neuloží nic.

**Neověřeno živě** (potřebuje test v Jakubově Chrome):
1. Jestli DBSC (`__Host-sessionBinding`) výměnu cookies snese. Pokud ne, vrátit se k B (`c945f65`).
2. Jestli funguje tichá kontrola přes DNR (Cookie header na vlastním fetchi rozšíření) a jak `/api/frame` odpoví účtu bez přístupu.
3. Jak přesně vypadá logout request, který claude.ai po změně účtu posílá, a jestli ho blokace chytí.
4. Claude in Chrome a další věci přihlášené přes claude.ai cookies v tomhle profilu se přepnou s ním.
5. Šedá zóna ToS: přepínání víc vlastních účtů v jednom prohlížeči. Nic se neobchází, jen se prohazují vlastní cookies.

## 0. Rozhodnutí (17. 11. 2026, překonáno sekcí 0a)

Jakub nechal rozhodnutí na agentovi („rozhoduj ty, vyber to nejlepší“). Platí tohle, otázky v sekci 6 jsou tím uzavřené:

1. **Varianta B: Chrome profil na účet + lokální router (native messaging host).** Ne A.
   - Funguje jistě. Nestojí na DBSC ani na interních cookies a úložištích claude.ai, které se můžou kdykoli změnit. Živý test DBSC odpadá.
   - Rozšíření **neukládá žádné session ani cookies**. Každý profil se přihlašuje normálně přes Anthropic, takže odpadá riziko úniku i šedá zóna v podmínkách.
   - Nehrozí „involuntary logout“ ani rozbití session, které sdílí proxy pool.
   - Cena: každý účet má vlastní okno Chrome (profily mají vlastní barvu a avatar, takže je hned vidět, kde jsi) a jednorázová instalace pomocníka (`npm run install-host`).
2. **Jak to funguje:**
   - Otevřeš artifact v profilu, jehož účet ho neotevře.
   - Rozšíření se zeptá `/api/frame/<uuid>?bk=probe`. Když dostane 401/403/404, otevře odkaz ve správném profilu přes pomocníka (`open -na "Google Chrome" --args --profile-directory=…`) a původní tab zavře.
   - Když se správný profil neví, zkouší postupně další profily. Pokusy eviduje sdílený stav v pomocníkovi, takže nevznikne smyčka.
   - Popup: seznam účtů, klik = otevře claude.ai v profilu daného účtu.
3. **Stack:** Solid + rollup/babel přesně podle Helmu, `@types/chrome`, `tsc --noEmit`, testy přes `node --test`.
4. **UI:** varianta A (seznam účtů), anglicky. Sekci „This tab“ přebírám z varianty B, jen v jednodušší podobě.
5. **Výchozí režim:** Auto. Je bezpečný, protože se jen otevírá odkaz v jiném profilu a nic se nepřepisuje. Volby Ask/Off zůstávají.
6. **Šifrování:** není potřeba, nic citlivého se neukládá. Sdílený stav obsahuje jen e-maily, názvy orgů, UUID artifactů a jména profilů.
7. **Tichý probe za ostatní účty:** v B není možný (každý profil vidí jen svoje cookies). Místo něj sdílená cache „artifact → účet“ napříč profily.
8. **Okena proxy jako zdroj** (otázka 10): zatím ne, cache stačí.

**Neověřeno živě** (potřebuje profily s účty, ověří se při prvním použití):
- že `open -na "Google Chrome" --args --profile-directory=…` otevře odkaz v už běžícím Chrome ve správném profilu;
- že pomocník najde vlastní profil rozšíření podle nonce v `Local Extension Settings` (záloha: ruční výběr v popupu);
- jak přesně odpoví `/api/frame/<uuid>?bk=probe` účtu bez přístupu (kód se řídí tím, co dělá stránka claude.ai sama; při jakékoli nejasné odpovědi nedělá nic).

Sekce 1–5 níže jsou původní research. Část o variantě A zůstává jako záznam, nestaví se.

---

## 1. Co jsem zjistil

Každé tvrzení má zdroj: **[live]** = ověřeno přímo na tvém Chrome nebo na claude.ai (jen názvy cookies a metadata, žádné hodnoty), **[bundle]** = přečteno ve veřejném JS claude.ai, **[src]** = zdrojáky existujících rozšíření nebo docs, **[odhad]** = odvozeno, neověřeno.

### 1.1 Jak drží claude.ai přihlášení

Cookies claude.ai ve tvém profilu `Default` [live, jen názvy a flagy z `Cookies` DB, read-only]:

| Cookie | Doména | Flagy | Životnost | Role |
|---|---|---|---|---|
| `sessionKey` | `.claude.ai` | httpOnly, Secure, Lax | ~28 dní | **přihlášení** (hlavní kredenciál) |
| `sessionKeyLC` | `.claude.ai` | Secure, ne httpOnly | stejně jako sessionKey | nejspíš „logged-in check“ pro JS [odhad] |
| `routingHint` | `.claude.ai` | httpOnly | 30 dní | vzniká s loginem, je per-účet [odhad] |
| `lastActiveOrg` | `.claude.ai` (doménová, ne host-only) | ne httpOnly | 1 rok | výchozí org |
| `__Host-sessionBinding` | `claude.ai` (host-only) | httpOnly | **10 min** | **device-bound session (DBSC)**, viz níž |
| `__Host-sessionBindingGrace` | `claude.ai` (host-only) | httpOnly | 20 min | tolerance pro binding |
| `activitySessionId` | `claude.ai` | | 12 h | aktivita |
| `anthropic-device-id` | `claude.ai` | | ~10 měsíců | zařízení, **nepřepínat** |
| `ion-vk` | `claude.ai` | httpOnly, session | – | nastavuje se i anonymně, nepatří k účtu [live, curl] |
| `cf_clearance`, `__cf_bm`, `_cfuvid` | `.claude.ai` | partitioned (CHIPS) | – | Cloudflare, **nepřepínat** |
| ostatní (`ajs_*`, `intercom-*`, `__stripe_mid`, UI prefs) | | | | analytika a UI, nepřepínat |

`sessionKeyV2` (zmiňují ho starší zdroje) u tebe neexistuje.

**Zásadní nález: claude.ai používá v Chrome DBSC (Device Bound Session Credentials)** [live].
- Profil má v `Device Bound Sessions` DB jednu DBSC session pro `https://claude.ai`.
- Cookie `__Host-sessionBinding` platí jen 10 minut. Chrome ji sám obnovuje: podepíše požadavek klíčem, který nejde vyexportovat (Secure Enclave nebo softwarový klíč).
- Co z toho plyne: **zkopírovat `sessionKey` nestačí, pokud server vyžaduje i platnou binding cookie, která patří ke stejné session.** Existující přepínače ([SB] dotKa/claude-switchboard, [WZ] wilinz/claude_account_manager, oba z 2026) prohazují cookies a podle autorů fungují. DBSC ale nikde nezmiňují. [WZ] výslovně nemaže IndexedDB `claude-device-binding` („non-exportable device key“), takže vazba může být **na zařízení, ne na session**. Pak by přepínání fungovalo. To je otázka č. 1 pro živý test.

**Nativní multi-account:** claude.ai umí přepínat jen **orgy v rámci jednoho e-mailu** (menu s iniciálami). Různé e-maily = odhlásit a přihlásit [src: support.claude.com]. Rozšíření je tedy potřeba jen mezi různými e-maily.

**Odhlášení ruší session na serveru** [src: support + [WZ]/[SB]]. Plyne z toho:
- Rozšíření **nikdy nevolá `/logout`**. Přepnutí jen lokálně vymění cookies.
- „Přidat účet“ = uložit aktuální session → lokálně smazat cookies → otevřít `claude.ai/login`. Neodhlašovat.
- Pozor na „Log out of all sessions“ u kteréhokoli ze tří účtů: odhlásí i Claude Code CLI / proxy pool na tom účtu [odhad pro proxy].
- **Past:** když claude.ai tab běží během výměny, SPA zjistí, že účet v cache nesedí s cookie, a samo zavolá `/logout?involuntary=1`. Tím zruší **novou** session [src: SB]. Proto: před výměnou všechny claude.ai taby „zaparkovat“ (přesměrovat na stránku rozšíření) a promazat stav vázaný na účet (localStorage/IndexedDB), kromě device-binding úložišť.

### 1.2 Jak se načítá artifact a jak poznat „nemám přístup“

- **Krátké id v URL = base58 (bitcoin abeceda) z UUID artifactu** [live: ověřeno na 2 tvých artifactech]. Rozšíření převede `claude.ai/artifact/A3o39SK4R27SRxiSbg22uX` na UUID lokálně, bez requestu. Varianty URL [src: parser v Claude Code binárce]: `/artifact/`, `/code/artifact/`, `/code/frame/`, volitelný `vanity-` prefix, UUID nebo 22znakové base58, volitelný `?sk=` (share key).
- **HTML je vždycky 200** (SPA shell), i pro neexistující id [live, curl]. Status hlavního dokumentu nic neříká. Shell má v `<html data-frame-uuid=…>` UUID.
- Stránka si přístup ověří přes **`GET https://claude.ai/api/frame/<uuid>?org=<orgUuid>&bk=probe`** (same-origin cookies). **401/403/404 = bez přístupu** [bundle: `frame-shell-*.js`]. Podle Claude Code binárky [src]:
  - 200 → přístup OK
  - 404 `not_found` → nesdíleno s tímto účtem / smazáno
  - 403 `reason: org_mismatch` + `owner_org` → patří do jiného orgu
  - 403 `request_access` → přihlášen, ale nepozván
- **Přepínání orgu v rámci jednoho účtu už claude.ai řeší sám** [bundle]: `POST /api/frame/member-org {artifact}` vrátí 403 `org_mismatch` + `owner_org` a stránka přepne org („boot-org-fallback“). **Rozšíření tedy musí řešit jen přepnutí mezi účty.**
- Identita účtu: `GET /api/account` → `email_address`, `memberships[].organization.{uuid,name}` [src + bundle].

### 1.3 Chrome platforma (MV3)

- `chrome.cookies` umí číst i zapisovat httpOnly cookies claude.ai s host permission `https://claude.ai/*`. Host-only cookies (`__Host-*`, `activitySessionId`) se musí zapsat **bez** `domain`, jinak vznikne duplicitní `.claude.ai` kopie. Partitioned (Cloudflare) se nechávají být.
- **Tiché ověření jiného účtu bez viditelného přepnutí:** `fetch` hlavičku `Cookie` nastavit nesmí (zakázaná hlavička). Jde to přes **DNR session pravidlo** `modifyHeaders: set cookie` omezené na `initiatorDomains: [id rozšíření]`, `tabIds: [-1]` a jednorázový nonce v URL; k tomu `remove set-cookie` v odpovědi. Docs ani Chromium source tomu nebrání [src]. Živě to ale nikdo proti claude.ai neověřil a **DBSC to může zablokovat** (binding cookie patří aktuálnímu účtu).
- `chrome.storage.local` je na disku **nešifrovaný** (LevelDB v profilu, jde i do Time Machine). Chrome vlastní cookies šifruje klíčem z Keychainu. Uložením session do rozšíření se tedy jejich ochrana snižuje.

---

## 2. Návrh řešení

### Varianta A (doporučená, pokud projde živý test): výměna cookies v jednom profilu

**Uložení účtu** (tlačítko „Save current account“):
1. `GET /api/account` → uuid, e-mail, orgy.
2. Snapshot cookies vázaných na účet: `sessionKey`, `sessionKeyLC`, `routingHint`, `lastActiveOrg`, `activitySessionId` + **binding cookies podle výsledku testu**.
3. Uložit do `chrome.storage.local` (`setAccessLevel TRUSTED_CONTEXTS`). Nikdy `storage.sync`.
4. Automaticky ukládat jen po explicitním „Add account“ a s potvrzením e-mailu (ochrana proti tomu, aby se uložil cizí, podstrčený login).

**Přepnutí** (stavový automat, zámek v `storage.session` s TTL):
1. Zaparkovat claude.ai taby (přesměrovat na `switching.html` rozšíření).
2. Obnovit uložený snapshot odcházejícího účtu, ale jen když `/api/account.uuid` sedí s uloženým uuid.
3. Smazat cookies vázané na účet → zapsat cookies cílového účtu.
4. Promazat stav vázaný na účet (localStorage/IndexedDB/Cache Storage) **kromě** `claude-device-binding` a `x-ark-arid-*`.
5. Ověřit přes `/api/account`, že je aktivní správný účet. Když ne → rollback a účet označit jako „session expired“.
6. Vrátit taby (artifact tab na artifact, ostatní na `/new`). Odemknout.

**Auto-switch pro artifacty:**
1. `tabs.onUpdated` (stačí host permission, nepotřebuje varovné `webNavigation`) zachytí URL artifactu → base58 → UUID.
2. Pořadí:
   1. **cache** `artifactUuid → (accountUuid, orgUuid)`; když ukazuje na jiný účet, rovnou přepnout;
   2. **probe aktuálním účtem** (`/api/frame/<uuid>?org=…&bk=probe`); 200 → nic nedělat;
   3. 403 `org_mismatch` → `owner_org` dohledat v orgách uložených účtů. Jde o jiný org stejného účtu → nechat na claude.ai. Patří jinému účtu → přepnout;
   4. 404 / `request_access` → **tichý probe ostatních účtů** přes DNR (pokud projde test), jinak **viditelné zkoušení** zbylých dvou účtů (pořadí podle naposledy úspěšného účtu v cache; Claude Code přes proxy pool může publikovat z kteréhokoli). Při 3 účtech to jsou max. 2 pokusy;
   5. výsledek uložit do cache; negativní výsledek s TTL 10 min.
3. Režim **Auto / Ask / Off**. Při Auto toast „Switched to … · Undo“ a badge s iniciálou aktivního účtu na ikoně.
4. Přepíná jen na uložené účty a jen při top-level navigaci (ochrana proti tomu, aby libovolný web přepínal účty podstrčeným odkazem).

**Oprávnění:** `cookies`, `storage`, `declarativeNetRequestWithHostAccess` (bez instalačního varování), `scripting` (purge přes content script), host `https://claude.ai/*`, `"incognito": "not_allowed"`. Žádné `<all_urls>`, `tabs`, `webNavigation` ani `browsingData`.

### Varianta B (záloha, pokud DBSC výměnu cookies zablokuje): Chrome profil na účet + router

- Každý účet ve vlastním Chrome profilu (přihlášený normálně, žádné kopírování session).
- Rozšíření v každém profilu: odkaz na artifact se otevře ve špatném profilu → probe → otevřít ve správném profilu přes **native messaging host** (`open -na "Google Chrome" --args --profile-directory=… <url>`).
- **Plus:** rozšíření neukládá žádné kredenciály (výrazně bezpečnější), DBSC nevadí.
- **Mínus:** víc oken a profilů, instalace native hostu, „který účet otevře artifact“ se musí odhadnout bez tichého probe (cache, jinak zkoušet profily postupně). Popup místo přepínání účtu „přepíná okno/profil“.

### Ještě levnější alternativa (doplněk, ne náhrada)

Claude Code by mohl publikovat artifacty sdílené na tvůj hlavní e-mail nebo org. Přes `claude-artifacts` MCP to ale nejde (server sdílení měnit neumí); šlo by jen ručně v UI artifactu. Mimo scope rozšíření.

### Stack a vzhled

- Helm extension je ve skutečnosti **Solid + rollup/babel, ne React + Vite** (`vite.config.ts` tam je, ale build ho nepoužívá). Navrhuju převzít přesně Helm setup: `solid-js`, `build.mjs` (rollup + babel-preset-solid, IIFE), `build-workbench.mjs`, `@types/chrome`, `tsc --noEmit`.
- Vzhled podle `helm/docs/design-system.md` a `widget.styles.ts`: tokeny 1:1, dark only. Helm `popup.html` je starý VS Code styl, ten nekopírovat.
- Workbench: varianty jako samostatné HTML (hotové, sekce 5). Po výběru se popup postaví v Solidu a fixture stavy pojedou přes `workbench.tsx` podle vzoru Helmu.

---

## 3. Živý test (blokuje stavbu, potřebuje tvůj souhlas)

Bez tvého svolení jsem nesahal na cookies ani nepoužil prohlížeč. Pokus o otevření artifactu v Chrome přes Claude in Chrome zablokoval permission klasifikátor, takže body níže jsou neověřené.

Navrhuju malé „probe“ unpacked rozšíření (jen čte, nic neukládá, hodnoty nikde nevypisuje), nebo že to projdeš v DevTools:

1. **DBSC:** ve druhém Chrome profilu (testovací, ne Default) se přihlas účtem A, rozšíření uloží jeho cookies; přihlas účet B (přes „vymazat lokálně“, ne logout); obnov cookies A. Funguje `/api/account` a načtení artifactu? Projde i po 15 minutách (binding cookie vyprší a musí se obnovit)?
2. **Tichý probe:** DNR `set cookie` na background `fetch` `/api/frame/<uuid>`: dostane jiný než aktuální účet 200/404 podle reality? Nechallenguje to Cloudflare?
3. **Co vidí cizí účet:** otevři artifact od ucet1 v účtu bez přístupu a zapiš status `/api/frame/<uuid>` a názvy JSON klíčů (ne hodnoty).
4. **Rotace sessionKey:** mění se hodnota `sessionKey` při běžném používání? (Rozšíření porovná hash, hodnotu neukáže.)
5. **Úložiště vázané na účet:** názvy klíčů localStorage/IndexedDB, které je potřeba při přepnutí smazat.

Výsledek rozhodne A vs. B. Odhad: 20–30 min tvého času.

---

## 4. Bezpečnost a rizika

| Riziko | Opatření |
|---|---|
| Session v `storage.local` nešifrovaně na disku a v zálohách | ukládat jen minimum; `TRUSTED_CONTEXTS`; volitelně šifrování heslem (AES-GCM + PBKDF2, odemknutí jednou za start Chrome); varianta B tohle riziko úplně eliminuje |
| Únik přes logy, export, URL | typ `Secret` s redigovaným `toString/toJSON`; žádný `console.*` u cookies; popup hodnoty nikdy nezobrazuje; žádné secrets v URL; žádný export ve v1; test v CI, který spadne na `storage.sync` nebo na logování cookie |
| Supply chain (npm) | jediná runtime závislost `solid-js`; lockfile; `npm ci --ignore-scripts`; CSP `extension_pages` s `connect-src https://claude.ai`; žádné `externally_connectable`; kontrola `sender.id` |
| Odhlášení zruší uloženou session | rozšíření nikdy nevolá logout; parkování tabů proti „involuntary logout“; volitelný logout guard (zatím ne) |
| Podstrčený login se uloží jako účet | ukládat jen po explicitním kliknutí + potvrzení e-mailu; slot přepsat jen při shodě uuid |
| Libovolný web přepne účet odkazem na artifact | jen uložené účty, jen top-level navigace, toast + badge, režim Ask |
| Data mezi účty (otevřený chat pokračuje pod jiným účtem, např. contember data do osobního účtu) | parkování všech claude.ai tabů, purge stavu, ověření `/api/account`, trvale viditelný badge |
| Jiná rozšíření s `cookies` + claude.ai/`<all_urls>` už dnes vidí `sessionKey` | projít nainstalovaná rozšíření |
| Podmínky Anthropicu | Claude Code legal píše, že vývojáři nesmí „collect, store, or intermediate Claude.ai credentials or session tokens“. Míří to na produkty pro jiné uživatele, ale doslova to sedí i sem. Osobní nástroj = šedá zóna: nedistribuovat, přihlašovat jen přes Anthropic flow, riziko je na tobě. Contember org může mít vlastní pravidla. |

---

## 5. UI varianty popupu

Lokální HTML soubory (záměrně ne claude.ai artifact). Každý ukazuje 6+ stavů vedle sebe:

- `docs/variants/variant-a-list.html`: **A, seznam účtů.** Klasický seznam, aktivní řádek zvýrazněný, dole „Add account“ / „Save current account“, Auto/Ask/Off jako segmented control.
- `docs/variants/variant-b-identity.html`: **B, identita nahoře.** Velký blok „kdo jsem teď“, kompaktní „Switch to“, sekce „This tab“ s kontextem artifactu, nastavení a mapování na podstránce.
- `docs/variants/variant-c-command.html`: **C, command palette.** Filtr nahoře, ovládání klávesnicí (↑↓↵, 1–9), velmi husté, stavový řádek s režimem auto-switche.

---

## 6. Otevřené otázky

1. **Živý test (sekce 3):** smím ho připravit (probe rozšíření) a ty ho projdeš? Ve druhém, testovacím Chrome profilu?
2. **Varianta A vs. B:** pokud test projde, jdeme do A? Nebo chceš kvůli bezpečnosti rovnou B (profily, žádné uložené kredenciály)?
3. **Účty:** e-maily známe (`ucet1@`, `ucet2@`, `ucet3@example.com`). Zbývá: jak se do nich přihlašuješ (Google/SSO/magic link)? Je Contember org pod některým z nich?
4. **Stack:** Solid + rollup jako Helm (doporučuju; brief říkal React + Vite, Helm ale reálně React nepoužívá)?
5. **Výchozí režim auto-switche:** Auto, nebo Ask?
6. **Šifrování uložených session heslem:** ano (jedno heslo po startu Chrome), nebo ne?
7. **Tichý probe ostatních účtů na pozadí** (pokud technicky projde): povolit, nebo jen cache + viditelné zkoušení zbylých účtů?
8. **UI varianta:** A, B, nebo C (případně co zkombinovat)? Jazyk UI angličtina (jako Helm)?
9. **ToS:** bereš na vědomí šedou zónu kolem ukládání session tokenů?
10. **Okena proxy jako zdroj:** umí (nebo může umět) Okena proxy říct, přes který účet běžela session, jež artifact publikovala? Pak by rozšíření vědělo správný účet bez zkoušení.

---

## Zdroje

- [SB] https://github.com/dotKa/claude-switchboard · [WZ] https://github.com/wilinz/claude_account_manager · Greasyfork 541151
- https://support.claude.com/en/articles/13189465 (login) · /10310342 (log out all) · /13124001 (active sessions) · /9547008 (share artifacts)
- https://privacy.claude.com/en/articles/10023541 (cookies) · https://code.claude.com/docs/en/artifacts · https://code.claude.com/docs/en/legal-and-compliance
- Chrome docs: cookies, declarativeNetRequest, storage, tabs, permissions list; Chromium `ruleset_manager.cc`, `web_request_permissions.cc`, `cookies_api.cc`
- Live: Chrome 157 `Default/Cookies` a `Device Bound Sessions` (jen názvy a metadata, read-only, `immutable=1`), anonymní `curl` na claude.ai, veřejné JS bundly `assets-proxy.anthropic.com/claude-ai/v2/assets/v1/frame-shell-*.js`
