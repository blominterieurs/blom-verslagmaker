# Blom Verslagmaker

Zet een Fireflies samenvatting om in een uniform verslag in de Blom huisstijl, als A4 PDF of als Word bestand.

## Gebruik

1. Open de Verslagmaker en log in met je Blom-account (hetzelfde account als voor de Collectiekeuze).
2. Upload of plak de Fireflies samenvatting. Een agenda en een schermafbeelding van Speaker Talktime zijn optioneel.
3. Kies het soort gesprek of laat de Verslagmaker het herkennen. Voor een sollicitatiegesprek en een bila is er een vaste opzet.
4. Geef de sprekers een naam, controleer de gegevens en pas zo nodig teksten aan in het voorbeeld.
5. Download het verslag als PDF of Word.

Er wordt niets bewaard. Het verslag bestaat alleen in je browser zolang de pagina open is.

## Hoe het werkt

| Onderdeel | Waar | Wat |
|---|---|---|
| `index.html` | GitHub Pages | De hele app: wizard, opmaak, PDF en Word |
| `supabase/functions/verslag-maken` | Supabase project *Database V1* | Stuurt de tekst naar Claude en geeft het antwoord direct terug |

- Inloggen gaat via Supabase Auth. Alleen accounts op `@blominterieurs.nl` kunnen verslagen maken.
- De serverfunctie bewaart niets en logt geen inhoud. Er is geen database nodig.
- De API-sleutel van Anthropic staat alleen als geheim in Supabase, nooit in deze repository.

## Beheer

**API-sleutel instellen of vervangen**
Supabase → project *Database V1* → Edge Functions → Secrets → `ANTHROPIC_API_KEY`.
Een sleutel maak je aan op console.anthropic.com. Daar zie je ook het verbruik en stel je een maandlimiet in.

**Optionele instellingen** (ook als secret in Supabase)
- `ANTHROPIC_MODEL`: het Claude model, standaard `claude-sonnet-5-5`.
- `TOEGESTANE_ORIGINS`: de webadressen die de functie mogen aanroepen, standaard `https://blominterieurs.github.io`.

**Accounts**
Nieuwe collega's krijgen een account via Menu → Gebruikers in de Collectiekeuze. Bij de eerste keer inloggen kiezen ze zelf een wachtwoord.

**Serverfunctie bijwerken**
De code staat in `supabase/functions/verslag-maken/index.ts`. Uitrollen met de Supabase CLI:
`supabase functions deploy verslag-maken --no-verify-jwt --project-ref vvvsvgtmslsjegbxppjf`
(de functie controleert het inlogtoken zelf).
