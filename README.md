# Twitch Reklamfri

Eget webbläsartillägg som tar bort reklam på Twitch. Fungerar i Chromium-webbläsare (Brave, Chrome, Edge) och Firefox-baserade (Zen, Firefox 128+).

## Hur det fungerar
- **Byte av ström:** När Twitch lägger in reklam i videoströmmen hämtas en reklamfri reservström av samma kanal och visas i stället. När reklamen är slut byts det tillbaka.
- **Reserv:** Finns ingen reklamfri reservström tas reklamsegmenten bort, och spelaren tystas och döljs tills reklamen är slut.

## Installera
**Zen / Firefox:** Ladda ner den senaste `.xpi`-filen under [Releases](../../releases) och öppna den i webbläsaren. Uppdateringar kommer automatiskt.

**Brave / Chrome:** Klicka på **Code → Download ZIP** och packa upp till en fast mapp. Gå till `brave://extensions`, slå på **Utvecklarläge**, klicka på **Läs in okomprimerat tillägg** och välj mappen.

## Felsökning
Tryck F12, gå till Konsol och filtrera på `TTV-AB`.
