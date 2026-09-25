# SovNode (tipo Aider) — extensión de VS Code · v0.20

Chat en la barra lateral (ícono ◆) que habla con Gemini, OpenAI o Anthropic,
ve tu proyecto mediante un repo map, y **edita o crea archivos** con bloques
SEARCH/REPLACE, diffs unificados o reescribiendo el archivo completo (según el
modelo, como Aider).

## Qué hay (y dónde vive en el código)

| Función | Qué hace | Archivo |
|---|---|---|
| Multi-proveedor (Gemini/OpenAI/Anthropic) | El nombre del modelo decide el proveedor solo, sin selector aparte; cada uno usa su propia API key | `providers.js` |
| Formatos de edición (SEARCH/REPLACE, diff unificado, archivo completo) | Se elige solo según el modelo que escribe el código, o se fija con `/format`; los tres terminan en el mismo motor (todo-o-nada, reparación, verificación, undo) | `editFormats.js`, `editEngine.js` → `applyEdits` |
| Crear archivos y carpetas | `SEARCH` vacío + ruta nueva ⇒ se crea el archivo (y las carpetas que falten) | `editEngine.js` → `applyEdits`, `extension.js` → `writeChangeSet` |
| Edición multi-archivo | Cada bloque lleva la ruta en la línea de arriba; todo-o-nada en TODA la respuesta | `editEngine.js` → `parseEditBlocks`, `planChangeSet` |
| Archivos en el chat (`/add`, `/drop`) | Archivo activo + los que agregues; el modelo puede pedir más con `NECESITO_ARCHIVOS:` y se agregan solos | `extension.js` → `contextPaths`, `parseFileRequest` |
| Ronda de reparación | Si un SEARCH no calza, se le reenvía el fallo + contenido actual al modelo una vez (igual que `MAX_EDIT_REPAIR_ROUNDS` de SovNode-Web) | `extension.js` → `runTurn` |
| Git auto-commit | Si la carpeta es un repo, un commit por turno con solo los archivos tocados | `git.js` |
| `/undo` (`/undo task`) | Restaura archivos, borra los creados y quita el commit si sigue siendo el último; `/undo task` deshace TODOS los pasos de la última `/task` de un golpe, en orden inverso | `extension.js` → `undoLast`, `undoTask` |
| Explicación "qué y dónde" | El modelo explica cada cambio; la UI muestra tarjetas por archivo con línea, +/−, diff y enlace | `gemini.js` → `SYSTEM_PROMPT`, `media/chat.js` → `fileCard` |
| Costo por turno | Tokens de input / cache / output / razonamiento, latencia, costo en USD por llamada y por turno, total de sesión | `pricing.js`, `extension.js` → `logTurn` |
| Logs | Panel Output "SovNode" + `usage.jsonl` (comando "SovNode: Ver log de uso y costos" o `/log`) | `extension.js` → `appendUsageLog` |
| Streaming + pensamientos | Respuesta en vivo y resúmenes de razonamiento (Gemini y Anthropic; OpenAI por ahora sin streaming, ver v0.11 más abajo) | `gemini.js` → `streamGemini`, `providers.js` |
| Repo map | Firmas de funciones/clases reales (tree-sitter, 8 lenguajes) + PageRank real sobre el grafo de imports resueltos/menciones, personalizado hacia los archivos ya abiertos en el chat | `repoMap.js`, `treesitter.js` |
| Verificación automática | Tras escribir, revisa que cada archivo tocado compile/parsee (Python/JS/JSON) y opcionalmente corre un comando propio (`npm test`, etc.); si falla, el modelo se corrige solo antes del commit (hasta 2 rondas) | `verify.js`, `extension.js` → bucle de verificación en `runTurnInner` |

Seguridad: el modelo no puede escribir fuera de la carpeta del proyecto, ni en `.git/` ni `node_modules/` (`validatePath`).

## Multi-proveedor: Gemini, OpenAI o Anthropic (v0.11)
Como en Aider, no hay un selector de "proveedor" aparte -- el **nombre del
modelo** decide con quien hablar: `gemini-*` va a Gemini, `gpt-*`/`o<numero>-*`
(ej. `gpt-6-sol`, `o3-mini`) va a OpenAI, `claude-*` va a Anthropic
(`providerForModel` en `providers.js`). El desplegable de modelo en la UI ya
trae unos cuantos de cada uno agrupados, pero cualquier nombre que escribas a
mano en `sovnodeAider.model` (o `sovnodeAider.editorModel`) funciona igual
mientras el prefijo matchee.

Cada proveedor necesita su propia API key -- el botón 🔑 (o "SovNode: Set API
Key") pregunta primero cuál, con el que te falta arriba de la lista si es que
hay uno. Podés mezclar proveedores entre el modelo principal y el editor del
modo arquitecto: por ejemplo, Gemini planea y `gpt-6-luna` (el mas barato de
los tres) escribe el código. Si falta la key del proveedor que hace falta
para el turno que estás por correr, se avisa ANTES de llamar a nada -- no se
gasta la llamada del arquitecto para recién ahí fallar en el editor.

Limitación conocida de esta primera versión: OpenAI responde de un tirón
(sin texto letra-por-letra en vivo) porque su Responses API es mas nueva y
todavía no se valido el streaming contra tráfico real; Gemini y Anthropic sí
transmiten en vivo. Tampoco hay "extended thinking" activado para Claude
todavía (el `effort` solo ajusta el techo de tokens de salida, igual que en
Gemini y OpenAI).

## Logs de errores aparte + chat rediseñado (v0.14)
Cuando algo falla, el error va **aparte** del chat: pegalo con el botón 🐞
(abajo, al lado del cuadro de texto) o con `/bug`, y en el chat contá con tus
palabras qué estabas haciendo ("cuando disparo a un enemigo se cierra el
juego"). El log queda como un chip naranja arriba del cuadro de texto y se
manda en **cada** turno hasta que lo quites con la ✕, así podés seguir
charlando sobre el mismo bug sin volver a pegarlo. No se guarda en el
historial (no se paga dos veces).

Formas de adjuntar un log:

| Desde | Cómo |
|---|---|
| Lo que tengas copiado | 🐞 → "Desde portapapeles", o `/bug` a secas |
| Pegado a mano | 🐞 → pegalo en el cuadro → Adjuntar (Ctrl+Enter) |
| La terminal | seleccioná el texto → clic derecho → "SovNode: Adjuntar selección de la terminal como log de error" |
| Un archivo abierto | seleccioná → clic derecho → "SovNode: Adjuntar log de error" |
| El panel Problems | 🐞 → "Desde Problems", o `/bug problems` |
| Un error de SovNode | botón "🐞 Adjuntar como log" en la tarjeta del error |

Antes de mandarlo se limpia: se quitan los colores de la terminal, se tapan
cosas que parecen claves (`AIza…`, `sk-…`, `ghp_…`, `Bearer …`,
`password=…`), y si es muy largo se queda el principio y **el final** (donde
suele estar la línea del error). Clic en el chip para ver exactamente lo que
se manda. `/bug clear` quita todos; `/clear` también.

El chat en sí también se renovó: selectores de modelo que ya no se cortan,
pensamientos plegados por default, cronómetro del turno, contexto en
"pastillas" (archivos, logs, formato), bloques de código con botón Copiar,
listas numeradas, y el scroll ya no te arrastra al final mientras leés algo
más arriba (aparece un botón ↓ para volver).

## Blindaje (v0.13)
Pasada de auditoría contra bugs en todo el código, con un test de regresión
por cada uno. Lo que cambia para vos:

Las ediciones ahora respetan el archivo tal como está en disco: un archivo con
fin de línea de Windows (CRLF) sigue siendo CRLF, y uno con BOM conserva el
BOM (antes el primero volvía en LF, y git mostraba todo el archivo cambiado).
Las rutas con acentos (`código.py`) se reconocen; antes el bloque caía en el
archivo activo. Un SEARCH o REPLACE que contiene una línea `=======` (títulos
de Markdown/RST) ya no corrompe el archivo. "Crear" un archivo que ya existe
falla en vez de duplicarle el contenido, y un diff que borra un comentario
`-- x` (SQL/Lua) ya no se pierde en silencio.

El undo es más sólido: si algo falla o pulsás Detener durante la corrección
automática, lo que ya se escribió se puede deshacer; los archivos nuevos que
crea la corrección entran al commit y al undo; y dos `/undo` seguidos ya no
pierden un paso. `/clear` y los demás botones esperan a que termine el turno.

Seguridad: no se puede escribir en `.GIT/`, `.git./` ni `Node_Modules/` (en
Windows y macOS son la misma carpeta que en minúsculas).

Costos: con Claude, el costo real con caché antes se subestimaba mucho (los
tokens leídos de caché casi no se contaban); ahora es exacto, incluida la
escritura en caché (1.25x). Con OpenAI el razonamiento se cobraba dos veces.
El aviso de "respuesta cortada por límite de tokens" ahora funciona con los
tres proveedores, y un error de Anthropic a mitad de respuesta ya no se toma
como una respuesta completa.

Verificación: los `.jsx` ya no dan un error falso (Node no entiende JSX); en
Windows no se usa el "python" falso de la Microsoft Store; y la verificación
de Python ya no deja carpetas `__pycache__` en tu proyecto.

Rendimiento: el repo map ya no pierde memoria con tree-sitter en sesiones
largas, y el modo regex de respaldo no se traba con archivos grandes de
Java/C#/Kotlin (un patrón tardaba más de 1 s por archivo de 4000 líneas).

## Formatos de edición: SEARCH/REPLACE, diff unificado o archivo completo (v0.12)
Como en Aider, el modelo no siempre edita igual: cada formato le sale mejor a
distintos modelos. Con `sovnodeAider.editFormat` en `auto` (default) se elige
solo, por el modelo que **escribe** el código (el editor, en modo arquitecto):

| Modelo | Formato | Por qué |
|---|---|---|
| Chicos (`*-flash-lite`, `gpt-6-luna`, `claude-haiku-*`, `*-mini`) | archivo completo | copiar SEARCH exactos es justo lo que peor hacen; reescribir el archivo entero les sale mucho más confiable |
| …pero si los archivos en el chat pasan 12.000 caracteres | SEARCH/REPLACE | reescribir archivos grandes es caro y se corta por el límite de tokens |
| OpenAI (`gpt-*`, `o*`) | diff unificado | están muy entrenados en diffs |
| El resto (Gemini flash/pro, Claude Sonnet/Opus) | SEARCH/REPLACE | el más barato en tokens, y los modelos grandes lo hacen bien |

`/format` muestra qué formato se usaría ahora y por qué; `/format udiff` (o
`whole`, `search-replace`, `auto`) lo fija. El formato de cada turno aparece en
la línea de "Contexto" del chat (pasá el mouse para ver el motivo).

## Caching de contexto con Anthropic (v0.12.1)
Gemini y OpenAI cachean solos (implícitamente) cuando el principio del
mensaje se repite igual entre turnos; Anthropic no -- hay que decirle
explícitamente qué parte cachear. Antes de esta versión no se lo decíamos
nunca, así que con Claude "Input en cache" siempre daba $0 aunque el system
prompt fuera idéntico turno a turno.

Ahora se marcan dos anclas en cada llamada a Claude: el system prompt (fijo
mientras no cambies de formato de edición) y el último turno de historial
(no el actual, que siempre trae el archivo editado de nuevo y nunca va a
calzar con una caché vieja). El ahorro es real pero tiene un techo: el
archivo que estás editando cambia cada vez que lo tocás, así que esa parte
del mensaje se sigue pagando entera -- lo que se cachea es el system prompt
y el historial de turnos previos, no el archivo en sí.

## Historial mas liviano: sin los bloques de edición viejos (v0.12.2)
Aplica a los tres proveedores por igual. Antes, cada turno guardado en el
historial incluía la respuesta COMPLETA del modelo tal cual la escribió --
bloques SEARCH/REPLACE, un diff unificado, o (el peor caso) el archivo
ENTERO reescrito en formato "whole". Como el contenido actual de un archivo
siempre se manda fresco en "ARCHIVOS EN EL CHAT" apenas hace falta, ese
parche viejo no le aportaba nada al modelo en los turnos siguientes -- solo
se pagaba de nuevo, turno tras turno, mientras siguiera dentro de la ventana
de `sovnodeAider.maxHistoryTurns`.

Ahora el historial guarda la respuesta ya sin esos bloques (la misma prosa
que ya se le mostraba al usuario en el chat), así que la explicación de qué
se hizo sigue ahí para dar continuidad a la conversación, pero el código en
sí no se repite. No cambia el resultado de ningún turno ni el formato
elegido -- solo dejar de reenviar algo que el modelo no necesitaba volver a
leer.

Detalles que importan de cada uno:

- **Diff unificado**: no hacen falta números de línea (el cambio se ubica por
  el contexto). Si un hunk no calza entero, antes de rendirse se prueba sin las
  líneas en blanco de los bordes y **partido** en pedazos más chicos (el caso
  típico: el modelo copió mal UNA línea de contexto lejos del cambio). Si el
  texto aparece varias veces y el `@@ -N` trae número de línea, se usa para
  elegir la ocurrencia más cercana (solo si hay una sola más cercana — nunca se
  adivina). Crea archivos con `--- /dev/null`; borrar archivos no está soportado.
- **Archivo completo**: se **rechaza** si el modelo abrevió (`// ... resto del
  código igual ...`), porque en este formato lo que no se escribe se borra; la
  ronda de reparación le pide el archivo entero. Si la respuesta se cortó (el
  bloque quedó sin cerrar) **nunca** se escribe un archivo a medias. Una frase
  como "Abre \`index.html\` y pegá esto:" arriba de un ejemplo no pisa
  `index.html` (la línea tiene que ser SOLO la ruta). Si un archivo queda con
  mucho menos líneas que antes, se avisa. Para archivos con \`\`\` adentro
  (un README) se aceptan bloques de cuatro acentos.
- En cualquier formato, si el modelo igual contesta con bloques SEARCH/REPLACE o
  con un diff, se aplica lo que mandó (esos dos son inequívocos). "Archivo
  completo" solo se busca cuando ese es el formato pedido, para que un ejemplo
  con una ruta arriba nunca reescriba un archivo por accidente.

## Comandos del chat
`/format [auto|search-replace|udiff|whole]` · `/add ruta|glob` · `/drop ruta|all` · `/files` · `/undo` (`/undo force`) · `/undo task` (`/undo task force`) · `/clear` · `/map` · `/cost` · `/log` · `/diag` · `/architect` · `/editor <modelo>` · `/task <objetivo>` · `/help`

## Si algo falla
- `/diag` (o "SovNode: Diagnostico de conexion") revisa API key, conexión real con Gemini, si el modelo existe, git y entorno, y se copia con un botón.
- Todo error en el chat dice la **fase** del turno donde ocurrió y trae "Copiar diagnóstico" con stack + contexto (versión de VS Code/Node, depurador activo, proxy, config).

## Bug resuelto en v0.3: "Parse Error: JS Exception"
Causa real (reproducida): `res.setEncoding("utf8")`. Con F5 el depurador rastrea la red y mide `chunk.byteLength` de cada respuesta; con texto en vez de bytes eso es `undefined`, el inspector lanza "Missing dataLength in event" dentro del parser HTTP y Node lo reporta como "Parse Error: JS Exception". Ahora se reciben bytes y se decodifican con `StringDecoder`.

## Tareas autonomas de varios pasos (v0.5)
`/task <lo que quieres lograr>` (ej: `/task agrega login con email y contrasena`).
Un modelo "planificador" divide el pedido en una lista corta de pasos chicos
(puede pedir ver archivos con `NECESITO_ARCHIVOS` antes de planear) y despues
cada paso se ejecuta como un turno normal, uno tras otro, sin que tengas que
escribir "sigue" entre medio: cada paso pasa por todo lo que ya hace un turno
(edicion, ronda de reparacion, verificacion automatica si esta activada,
commit de git, undo por paso). En el chat aparece un panel con la lista de
pasos y cual esta corriendo. Si un paso falla (no se pudo aplicar, o error),
la tarea se DETIENE ahi -- nunca sigue construyendo sobre una base rota -- y
te avisa cual quedo pendiente; podes revisar, arreglar a mano o con un mensaje
normal, y seguir vos. Pulsa Detener en cualquier momento para frenarla entre
pasos. Cuantos pasos como maximo: `sovnodeAider.maxAutoSteps` (por defecto 6).
Combina bien con modo arquitecto y con verificacion automatica, que se aplican
igual dentro de cada paso.

## Undo de tarea completa (v0.8)
`/undo task` deshace de un solo golpe TODOS los pasos de la última `/task`
(archivos y sus commits de git), en orden inverso -- el paso mas reciente
primero, para que cada commit siga siendo el HEAD en el momento de
revertirlo. Si editaste a mano alguno de esos archivos DESPUES de que la
tarea terminó, se niega y te pide `/undo task force` para confirmar que
querés perder esa edición (igual que `/undo force` para un turno suelto). Si
el último cambio no vino de una tarea (fue un mensaje normal), te lo dice y
no toca nada -- para eso está el `/undo` de siempre.

## Repo map: tree-sitter real (v0.7)
La extracción de símbolos (funciones, clases, métodos, interfaces) que antes
se hacía con expresiones regulares ahora usa **tree-sitter de verdad**
(`web-tree-sitter` + gramáticas `.wasm` de `tree-sitter-wasms`, sin compilar
nada nativo -- funciona igual en Windows/Mac/Linux). Ya no confunde un string
o un comentario que "parece" una definición con una real, y entiende métodos
dentro de clases e interfaces. Cubre los mismos lenguajes de antes: Python,
JS/JSX/TS/TSX, Java, C#, Kotlin, Go.

Es la **primera dependencia npm del proyecto** -- por eso hace falta correr
`npm install` una vez (ver "Probar" mas abajo). Si no lo corriste, o algo del
`.wasm` no carga, la extensión **no se rompe**: cae sola de vuelta al
extractor por regex de siempre, con la misma calidad que tenía antes de esta
versión. `/diag` dice cuál de los dos modos está activo ("tree-sitter real
disponible" o "modo regex de respaldo").

Los imports que alimentan el PageRank (ver mas abajo) también se extraen con
tree-sitter ahora, para los 8 lenguajes soportados.

## Resolución de imports para Java/C#/Kotlin/Go (v0.10)
Estos 4 lenguajes ya usaban tree-sitter para extraer símbolos, pero sus
imports no resolvían a un archivo real -- solo contaban para el heurístico de
menciones de texto. Ahora sí resuelven, cada uno con la estrategia que le
corresponde a su forma de organizar el código (a diferencia de JS/Python, un
import acá puede coincidir con más de un archivo a la vez, y el peso del
import se reparte entre esos archivos):

- **Java y Kotlin**: `import com.acme.util.Helper` se resuelve por
  **paquete declarado + nombre de tipo** -- se arma un índice de
  `paquete.Tipo -> archivo` leyendo el `package` de cada archivo y sus
  clases/interfaces/records (más el nombre del archivo, por la convención de
  un tipo público por archivo). Un import con wildcard (`import com.acme.*`)
  resuelve a todos los archivos de ese paquete, si no son demasiados.
- **C#**: `using Acme.Util;` se resuelve por **namespace declarado** -- todos
  los archivos que declaran ese namespace (bloque clásico o "file-scoped" de
  C# 10) reciben la arista.
- **Go**: un import como `"acme/internal/util"` se resuelve leyendo el
  `module` de `go.mod` en la raíz, pelando ese prefijo, y mapeando lo que
  queda a los archivos `.go` de esa carpeta (los imports son por paquete, no
  por archivo). Sin `go.mod`, o si el import no matchea el módulo (una
  librería externa), se prueba por sufijo contra las carpetas reales del
  repo, igual que ya hacía Python para paquetes con la raíz más adentro que
  el workspace.

Si un import termina coincidiendo con demasiados archivos (nombre de paquete
o namespace muy genérico) se descarta -- queda solo el heurístico de
menciones de texto para ese caso, igual que antes de esta versión.

## Repo map: PageRank real sobre imports (v0.6)
El "mapa del repositorio" que ve el modelo (firmas de funciones/clases, no el
contenido completo) ahora ordena los archivos con un PageRank de verdad sobre
un grafo dirigido, no con un conteo simple de menciones. Dos fuentes de
aristas: imports/requires REALES resueltos a uno o varios archivos del
proyecto (JS/TS con `import`/`require`/`import()` dinamico y Python con
`from . import` / `import paquete.modulo`, resolviendo a un archivo exacto;
Java/Kotlin por paquete+tipo, C# por namespace y Go por modulo de `go.mod`,
que pueden resolver a varios archivos a la vez -- ver v0.10 mas abajo), con
peso alto; y menciones de texto de un simbolo definido en otro archivo, con
peso bajo, como respaldo cuando un import no se pudo resolver o coincidio con
demasiados archivos. Ademas es "personalizado":
el ranking se recalcula (barato, sin releer archivos) sesgado hacia los
archivos que ya estan en el chat, asi prioriza lo relacionado con lo que el
usuario esta mirando en vez de ser siempre el mismo orden fijo.

Sigue sin ser tree-sitter: la extraccion de simbolos sigue siendo por regex
(puede confundir un string que "parece" una definicion con una real). Eso
queda como el proximo paso planeado; ver `architecture.md`.

## Modo arquitecto (v0.4)
Botón 🏛 arriba del chat, `/architect` o "SovNode: Alternar modo arquitecto".
El modelo principal (arquitecto) razona y escribe un **plan** sin código
(puede pedir archivos con `NECESITO_ARCHIVOS`); después el **editor** lo
convierte en bloques SEARCH/REPLACE. Con `/editor gemini-3.1-flash-lite` (o
`sovnodeAider.editorModel`) el editor es un modelo más barato; vacío = el mismo.
Las rondas de reparación y de verificación también las hace el editor. Si el
pedido es solo una pregunta, el arquitecto responde `SIN_CAMBIOS` y no se gasta
la segunda llamada. El costo muestra cada llamada con su modelo.
Conviene para cambios grandes o de varios archivos; para ediciones chicas,
el modo normal es más rápido y barato.

### Selector de modelo económico del editor (v0.9)
Al activar el modo arquitecto aparece, al lado del botón 🏛, un desplegable
con todos los modelos disponibles ordenados del **más barato al más caro**
(por precio de output, que en general domina el costo real de una
respuesta), mostrando el precio de cada uno en $/M tokens de salida. Elegir
uno ahí hace exactamente lo mismo que `/editor <modelo>` -- son dos caminos
al mismo ajuste (`sovnodeAider.editorModel`), y se mantienen sincronizados:
cambiar por el desplegable actualiza lo que vería `/editor`, y viceversa. La
opción "(mismo que el principal)" limpia el ajuste, igual que `/editor` sin
argumentos. Los precios respetan los overrides de `sovnodeAider.pricing` si
los configuraste.

## Verificación automática (v0.3.1)
Después de aplicar un cambio, y antes de hacer el commit, SovNode revisa que
cada archivo tocado compile/parsee: `.py` con `py_compile`, `.js/.jsx/.mjs/.cjs`
con `node --check` (el propio Node de VS Code), `.json` con `JSON.parse`. Un
lenguaje sin verificador simplemente se salta (nunca se inventa un error). Si
además configurás `sovnodeAider.verifyCommand` (por ejemplo `"npm test"` o
`"pytest -q"`), también se corre y su fallo cuenta igual. Si algo falla, se le
manda el error real al modelo para que se corrija solo con nuevos bloques
SEARCH/REPLACE (hasta 2 rondas); si sigue fallando, los cambios quedan
aplicados igual pero con un aviso claro para revisarlos a mano. Se puede
desactivar con `sovnodeAider.verify: false`. Settings: `sovnodeAider.verify`,
`sovnodeAider.verifyCommand`, `sovnodeAider.verifyTimeoutMs`.

## Costos
Los tokens de **razonamiento** se cobran como output aunque no se vean, por eso
se muestran aparte (para OpenAI y Anthropic, `thoughtTokens` es 0 por ahora --
ver limitación conocida en la sección de multi-proveedor). Precios en
`pricing.js`; se pueden sobrescribir en Settings → `sovnodeAider.pricing`
(por campo, por modelo). Gemini verificado en ai.google.dev, OpenAI en
developers.openai.com/api/docs/pricing y Anthropic en platform.claude.com
(todos consultados sept 2026) -- los tres cambian de vez en cuando, revisa la
fuente si el número no te cierra. La cache cuesta 10% del input para los tres
proveedores (aproximado para OpenAI, que en realidad descuenta 50%).

## Probar
**Primera vez: correr `npm install` en esta carpeta** (una sola vez -- instala
`web-tree-sitter` + las gramáticas `.wasm` para el repo map real, ver mas
abajo; sin este paso la extensión igual funciona, solo que el repo map cae
al modo regex mas limitado de antes). Despues, F5 en esta carpeta → en la
ventana `[Extension Development Host]` abre una carpeta → clic en el ícono ◆
de la barra izquierda → 🔑 para la API key.

## Pendiente (siguientes pasos tipo Aider)
Soporte multi-root workspace (hoy siempre se usa la primera carpeta abierta).

## Contexto enfocado en archivos grandes (v0.15)

En un archivo de 400+ lineas ya no se manda el archivo entero en cada turno. Se mandan solo las partes que el pedido toca:

- las funciones o clases que nombras (o que nombra el plan del arquitecto),
- las lineas que aparecen en un log de error adjunto (`File "juego.py", line 212`),
- lo que tengas seleccionado en el editor,
- las lineas donde aparece un identificador que escribiste (`player.health`, `self.speed`),
- las primeras lineas del archivo (imports y constantes).

Ademas va un indice del resto (nombre y linea de cada funcion que no se mando), para que el modelo sepa que existe. En el chat el archivo aparece como 🎯 `archivo · 180/1200 lin.`

Si el pedido es generico ("mejora este codigo") o lo relevante es mas del 60% del archivo, va entero como antes. Si el modelo necesita otra parte, pide el archivo completo solo (`NECESITO_ARCHIVOS`) y la ronda de reparacion siempre ve el archivo entero, asi que un fragmento faltante no rompe la edicion. Con el formato "archivo completo" nunca se usa extracto.

Se ajusta con `sovnodeAider.focusLargeFiles` (lineas minimas, 400 por defecto; 0 lo apaga).

## El arquitecto recibe el archivo una vez, despues solo los cambios (v0.16)

En modo arquitecto, el archivo se le manda al arquitecto como "version base" al PRINCIPIO del pedido, y en los turnos siguientes esa base va identica (el proveedor la cobra como cache: Gemini de forma automatica, Anthropic con `cache_control`) + al final solo un diff con lo que cambio desde entonces. Asi el arquitecto no "relee" y paga el archivo entero cada turno.

- El editor sigue recibiendo el codigo ACTUAL (necesita copiar texto exacto para sus bloques SEARCH).
- Si los cambios acumulados pasan de un tercio del archivo, la base se renueva (ese turno no aprovecha cache; los siguientes si).
- `/clear` descarta las bases. En el chat se ve como 📌 `archivo · base + N lin.` (o "base nueva").
- Se apaga con `sovnodeAider.architectBaseCache: false`.
- Fijate la linea "Input en cache" del costo: desde el segundo turno del arquitecto deberia dejar de ser 0. El cache automatico de Gemini no esta garantizado en cada llamada.

## Extended thinking de Anthropic + errores de verificacion comprimidos (v0.17)

Dos ajustes puntuales para acercar la calidad de Claude a la de Claude Code sin perder el control de costos que ya tiene SovNode:

- **Extended thinking (solo Anthropic):** antes SovNode nunca activaba el razonamiento extendido de Claude; el modelo respondia de una, sin la fase previa de "pensar" que Gemini y OpenAI ya hacen segun el Effort. Ahora se activa automaticamente cuando el Effort del turno es **high** o **extra** (en low/medium se deja apagado a proposito, es mas barato). Se ajusta con `sovnodeAider.extendedThinking` (activado por defecto).
- **Errores de verificacion comprimidos:** cuando falla el comando de verificacion del proyecto (tests, build), en vez de mandarle al modelo los primeros 4000 caracteres a lo bruto (que en muchos test runners es solo el encabezado, no el error), ahora se buscan las lineas que parecen el error real (Error, Exception, Traceback, FAILED, `archivo:linea`, etc.) + contexto alrededor + el final de la salida, y se le manda eso. Si no hay ninguna linea reconocible, se cae al recorte de siempre.

Estos dos cambios no tocan Gemini (que ya piensa segun el Effort) ni el resto del flujo de edicion.

## Micro-herramientas: leer y buscar a mitad del turno (v0.18)

Si lo que el modelo recibio no le alcanza (necesita ver otra parte de un archivo, otro archivo, o donde se define/usa algo), ahora puede pedirlo en vez de adivinar:

```
HERRAMIENTAS:
leer: base de dooom.py 120-180
buscar: draw_map
```

SovNode lee eso, le devuelve solo esas lineas / esas apariciones (`archivo:linea: codigo`) y el modelo sigue. En el chat aparece "SovNode consulto: ...".

Pensado para NO disparar el costo:

- Se usa solo si hace falta: el mapa, el recorte por foco y la base del arquitecto siguen yendo primero. En un proyecto chico casi nunca se va a activar.
- Tope de rondas por turno segun el Effort: low 1, medium 2, high 3, extra 5 (`sovnodeAider.toolsMaxRounds` con un numero lo fija; 0 las apaga). En la ultima ronda se le avisa que responda con lo que tiene.
- Lo que ya tiene no se reenvia (v0.18.1): si pide lineas que ya estaban en el archivo/extracto que recibio, o que ya leyo en una ronda anterior, se le contesta "ya las tenes" y solo se mandan las que faltan. Una busqueda repetida tampoco se repite. Al final del turno se avisa cuanto se ahorro.
- `buscar` compacto (v0.18.1): primero donde se DEFINE (del mapa del repo), despues los usos, maximo 3 por archivo ("... y N mas en este archivo").
- Cada pedido devuelve poco: maximo 200 lineas por "leer", 20 resultados por "buscar", 5 pedidos y ~16.000 caracteres por ronda.
- Cada ronda agrega al final de la llamada anterior, asi lo ya enviado queda como prefijo identico y el proveedor lo puede cobrar como cache.
- Los resultados NO quedan en el historial: sirven para ese turno y se descartan.

## Log completo por sesion de VS Code (v0.19)

Ademas de `usage.jsonl` (una linea por turno, para siempre, resumido para el costo), ahora cada vez que se abre esta ventana de VS Code se crea un archivo de log nuevo con el detalle completo de todo lo que pasa: contexto enviado, cada llamada al modelo, rondas de herramientas y cuanto ahorraron, archivos cambiados, costo. Antes eso solo se veia en el panel "SovNode" del Output y se perdia al cerrar VS Code.

- Se abre con el comando **SovNode: Ver log de esta sesion (completo)**.
- Se guarda en `sessions/session-<fecha>.log` dentro de la carpeta de datos de la extension; la ruta exacta sale en `/diag`.
- Se conservan los ultimos `sovnodeAider.sessionLogKeep` archivos (20 por defecto); los mas viejos se borran solos. `0` = no guardar ninguno.

## Ejecutar comandos a mitad del turno (v0.20)

La mitad que le faltaba al bucle de herramientas: ademas de leer y buscar, el modelo puede pedir CORRER algo puntual (compilar, un test especifico) y ver el resultado real antes de responder o de corregir, en vez de solo verify.js (que corre un comando fijo, siempre despues de editar).

```
HERRAMIENTAS:
ejecutar: npm test
```

Como esto corre algo de verdad en tu maquina, tiene mas resguardos que leer/buscar:

- **Siempre se te pide confirmar** cada comando con un dialogo, mostrando el comando exacto. Podes: Ejecutar (una vez), Ejecutar y confiar en ese comando exacto por el resto de la sesion, o No.
- **Una lista chica de patrones queda bloqueada siempre**, sin preguntar ni con "confiar": borrado masivo (`rm -rf`), formatear un disco, apagar la maquina, forzar en el remoto de git, y similares.
- **Nada de encadenar comandos.** `;`, `&&`, `||`, `|`, backticks, `$(...)`, redirecciones: se rechaza sin ejecutar. Tiene que ser UN comando simple, y se corre tokenizado a mano (nunca con una shell de por medio).
- **Tiempo maximo** por ejecucion (`sovnodeAider.execTimeoutMs`, 20s por defecto, tope duro 2 minutos): se corta solo.
- **Salida acotada y con secretos tapados** antes de que la vea el modelo (reusa la limpieza de logs.js).
- `sovnodeAider.execAllowlist`: comandos (o su inicio exacto) que se corren sin preguntar cada vez. Vacio por defecto.
- `sovnodeAider.execEnabled: false` apaga esto sin apagar leer/buscar.

En el chat vas a ver "Ejecutando: ..." y despues el resultado, igual que cualquier otra consulta de herramientas.

## Ajustes de costo v0.20.1

Dos hallazgos de un uso real (arquitecto barato + editor caro, `ejecutar` pidio el archivo equivocado):

- **La ronda de herramientas ya no repite el mismo presupuesto de razonamiento.** Cada `leer`/`buscar`/`ejecutar` obliga a una segunda llamada que reenvia toda la conversacion anterior (asi funcionan las APIs sin estado; eso no se puede evitar sin romper el cache de prefijo). Pero esa segunda llamada solo tiene que leer el resultado y responder, no volver a "pensar" el problema entero -- asi que ahora baja un escalon de Effort (`extra`→`high`→`medium`→`low`, nunca menos de `low`) SOLO para esa llamada de continuacion. El Effort que elegiste para el turno no cambia en nada mas.
- **Aviso de modelo caro (v0.20.3).** Si el modelo principal o el editor tiene un precio de salida de $8/M o mas (hoy: Claude Sonnet y Opus), en el primer turno de la sesion de VS Code que lo use aparece un aviso en el chat explicando que un turno con ese modelo puede salir varias veces mas caro que con un modelo flash barato haciendo el mismo trabajo. No bloquea nada ni cambia el modelo por vos, y no se repite en lo que queda de la sesion.
- **`ejecutar` avisa cuando el nombre de archivo esta mal.** Si el comando falla con "no existe el archivo" y uno de los argumentos, comparado sin importar mayusculas/acentos/espacios, se parece a un archivo real del proyecto (el caso de `python dooom.py` cuando el archivo es `base de dooom.py`), se le señala el nombre correcto en el resultado en vez de dejarlo adivinar de nuevo. Ademas, el prompt de `ejecutar` ahora pide explicitamente usar el nombre EXACTO del archivo (con comillas si tiene espacios).

## El mapa del repo se cachea (v0.21)

Antes el mapa del repositorio iba mezclado dentro del mensaje final (junto con los archivos y tu pregunta), ordenado segun lo que nombrabas y con el numero de linea de cada funcion. Como ese mensaje cambia siempre, el mapa nunca era texto identico y se pagaba entero en cada llamada, aunque no hubieras tocado nada del proyecto.

Ahora se manda en dos partes:

- **Mapa estable**, en su propio bloque al principio del pedido (antes del historial): firmas de clases/funciones sin numeros de linea y sin reordenar por pregunta. Es identico turno a turno mientras no agregues/quites funciones, asi que Gemini/OpenAI lo cachean solos y Anthropic lo marca con su propia ancla de cache.
- **Lo que depende del pedido**, chiquito, en el mensaje final: los simbolos que tu pregunta nombra, con `archivo:linea` actual.

Si una edicion solo mueve lineas, el mapa estable no cambia. `sovnodeAider.repoMapCache: false` vuelve al modo viejo.

## El historial se poda de a lotes, no turno a turno (v0.21.2)

Antes, `maxHistoryTurns` funcionaba como una ventana deslizante: en cada turno se tiraba el mas viejo y se agregaba el nuevo. Pasado ese limite, el bloque de historial nunca era identico al del turno anterior, asi que ni el cacheo automatico de Gemini/OpenAI ni el cache explicito de Anthropic podian aprovecharlo -- en sesiones largas, el historial se pagaba a precio de reescritura de cache (mas caro que a precio normal) en casi todos los turnos.

Ahora el historial solo CRECE (agregando al final, que es cacheable) hasta pasarse de `maxHistoryTurns` por un margen, y ahi se poda de una sola vez de vuelta al limite configurado. El contexto retenido en promedio es el mismo; lo que cambia es que el prefijo se mantiene estable durante varios turnos seguidos en vez de cortarse en cada uno.


## Matado de arbol de procesos + Detener conectado (v0.21.3)

Dos huecos reales en `ejecutar` (v0.20):

- **El boton "Detener" no cortaba un comando en curso.** Cortaba la llamada al modelo, pero un comando ya corriendo seguia hasta su propio timeout (hasta 2 minutos) igual. Ahora Detener corta el comando al toque.
- **El timeout solo mataba el proceso directo.** Si el comando lanzaba otros procesos (por ejemplo `npm test` levantando workers), esos quedaban corriendo huerfanos aunque el timeout "cortara" el comando. Ahora se mata el arbol completo (en Linux/Mac via grupo de procesos, en Windows via `taskkill /T`).

De paso, se arreglo un bug de validacion: un comando con una arrow function de JS (`node -e "algo=>algo"`) se rechazaba como si tuviera una redireccion, por el `>` de la flecha. Ya no.


## El Language Server enriquece la correccion por verificacion (v0.21.4, modo hibrido)

Cuando `verify.js` encuentra un error de sintaxis real (via `py_compile`/`node --check`, que siguen siendo la fuente de verdad -- eso no cambia), ahora se le suma el detalle que ya tenga calculado el Language Server de VS Code para ese mismo archivo (Pylance, tsserver, ESLint, el que corresponda): tipo de error, regla de lint violada, columna exacta -- en vez de solo el texto crudo del compilador. Si no hay Language Server instalado para ese lenguaje, o todavia no termino de analizar (es asincrono, no hay garantia de que ya este listo), simplemente no se agrega nada -- nunca se interpreta "sin diagnosticos" como "esta todo bien".


## Memoria del proyecto (v0.22.0)

Comando **"SovNode: Editar memoria del proyecto"**: crea (si no existe) y abre `.sovnode/memoria.md` en tu carpeta. Escribí ahí lo que el modelo no puede deducir leyendo el código: convenciones, decisiones ya tomadas y por qué, cosas que no hay que tocar. Se manda en cada pedido como el primer bloque, cacheable.

Costo, sin vueltas: no es "siempre más barato". Si el archivo no existe, está vacío o es la plantilla sin completar, cuesta cero. Si tiene contenido, pagás esos tokens en cada turno, pero a precio de cache (~10% en Anthropic, descuento automático en Gemini/OpenAI) mientras no lo edites. Conviene mantenerlo corto y editarlo de vez en cuando, no a cada rato: cada edición rompe el cache de todo lo que viene detrás por un turno. El modelo no lo edita solo, justamente por eso. Tope: 6000 caracteres (lo que sobra se recorta con aviso). Se apaga con `sovnodeAider.projectMemory: false`.


## Búsqueda real en el repo (v0.23.0)

Las micro-herramientas del modelo ahora buscan en todo el proyecto (código, config, docs), no solo en los archivos que entiende el mapa del repo. Antes un `.yaml`, `.json`, `.md` o `.html` era invisible para `buscar:`.

- `buscar: texto`: igual que antes, texto exacto.
- `buscar: /regex/i`: expresión regular (la `i` ignora mayúsculas).
- `buscar: texto en: src/**/*.py`: solo en los archivos que matchean el patrón.
- `archivos: src/**/*.py`: lista qué archivos existen (hasta 60), para que el modelo no tenga que adivinar rutas.

Mismo costo que antes: cada uso sigue siendo una consulta dentro del tope de rondas, y los resultados siguen recortados.


## Modo agente para /task (v0.24.0, opcional)

Se activa y desactiva con el botón 🤖 del chat, con `/agent` (`/agent on` / `/agent off`) o con el comando "SovNode: Activar/desactivar modo agente". Viene **apagado**: `/task` sigue igual que siempre y se detiene en el primer paso que falla.

Con el modo agente activado, si un paso falla (error, edits que no aplican o verificación que no pasa):

1. **Reintenta** ese paso hasta 2 veces, pasándole al modelo el error real y los intentos anteriores para que cambie de enfoque.
2. Si falla **dos veces con el mismo error**, no insiste: **replanifica** los pasos que faltan con otro enfoque (una vez por tarea).
3. Si sigue trabado, **se detiene** y te dice por qué y cuánto gastó.
4. "Funcionó" lo decide la verificación real (compilación, `verifyCommand`), no otra llamada al modelo.

**Presupuesto** (`sovnodeAider.taskBudgetUSD`, por defecto 0,50 USD por tarea): al llegar al tope, pausa y pregunta si seguir (otro tanto) o detener. 0 = sin tope. El progreso muestra lo gastado en vivo.

Costo: si todo sale a la primera, cuesta lo mismo que sin modo agente. El extra aparece solo cuando algo falla (reintentos y replanteo), y el presupuesto le pone techo.


## Herramientas nativas (v0.25.0)

Las herramientas del modelo (`leer`, `buscar`, `archivos`, `ejecutar`) ahora usan el mecanismo **nativo** de cada API (Gemini, OpenAI, Anthropic) en vez de pedirle al modelo que escriba `HERRAMIENTAS:` como texto. Los modelos grandes están entrenados para esto: se equivocan menos de formato, así que hay menos rondas desperdiciadas.

Todo lo demás es igual: mismos topes de rondas, misma deduplicación ("eso ya lo tenés"), mismos recortes y `ejecutar` sigue pidiendo tu aprobación. El costo por ronda es el mismo; las definiciones de herramientas son fijas y entran en el caché.

Si un modelo rechaza las herramientas nativas, SovNode repite esa llamada con el protocolo de texto y sigue así por el resto de la sesión, con un aviso. Para usar siempre el texto: `sovnodeAider.nativeTools: false`.


## Modelo barato para los pasos del agente (v0.26.0)

Con el modo agente activado, podés elegir un modelo barato para los pasos: `/stepmodel gemini-3.6-flash` (o el ajuste `sovnodeAider.agentStepModel`).

- El modelo principal **planifica** y **replanifica**: pocas llamadas, donde más importa pensar bien.
- El modelo barato **hace cada paso**: la mayoría de las llamadas de una tarea.
- Si un paso falla, el reintento **escala al modelo principal solo para ese paso**. El siguiente paso vuelve a empezar con el barato.

Al terminar, SovNode te dice cuántos pasos resolvió el barato, cuántos tuvieron que escalar y cuánto costó la tarea. `/stepmodel` sin nada lo desactiva. Sin modo agente no tiene efecto.


## Modo Auto (v0.27.0)

Elegí **"Auto (elige SovNode)"** en el selector de modelo, o escribí `/auto` (`/auto off` para volver a un modelo fijo). SovNode elige el modelo de cada operación con reglas, **sin gastar una llamada extra** en analizar la tarea.

**Niveles.** Barato, medio y fuerte, elegidos entre los modelos para los que tenés API key, ordenados por precio. Podés fijarlos con `sovnodeAider.autoModels`, por ejemplo `{"barato": "gemini-3.6-flash", "medio": "claude-sonnet-5", "fuerte": "claude-opus-5-5"}`.

**Cómo elige el nivel de cada turno.** Suma un punto por cada señal: contexto grande (4 archivos o más, o más de 40k caracteres), pedido largo, palabras de dificultad ("refactorizá", "arquitectura", "por qué falla", "rendimiento"...), un error adjunto con `/bug`, o que el turno anterior haya fallado. 0 puntos = barato, 1-2 = medio, 3 o más = fuerte.

**Qué hace con cada operación:**
- **Nivel fuerte** activa el arquitecto solo: el fuerte planea y el medio escribe el código.
- **`/task`**: el fuerte planifica y cada paso se enruta solo. Con modo agente, los pasos van con el barato y escalan al fuerte si fallan.
- Mientras Auto está activo, ignora `/architect`, `/editor` y `/stepmodel`.

Cada turno muestra qué nivel eligió y por qué, por ejemplo: "Auto → nivel medio: gemini-3.6-flash (hay un error/log adjunto)".


## Idioma: español e inglés (v0.28.0)

La interfaz está en español e inglés. Por defecto sigue el idioma de VS Code: español si VS Code está en español, inglés en cualquier otro caso. Para fijarlo: `sovnodeAider.language` = `auto` / `es` / `en`. Al cambiarlo, el panel del chat se recarga con el idioma nuevo.

Se tradujeron los mensajes del chat, los botones, los avisos, `/help`, `/diag`, los comandos de la paleta y las descripciones de los ajustes. Las respuestas del modelo ya salían en el idioma en que le escribas; eso no cambia. Quedan en español solo los logs internos (el log de sesión y el canal de salida).

---

## Language: Spanish and English (v0.28.0)

The UI is available in Spanish and English. By default it follows VS Code's display language (Spanish if VS Code is in Spanish, English otherwise). To force one: `sovnodeAider.language` = `auto` / `es` / `en`. The model already answers in whatever language you write in.


## Auto: probar barato, verificar y escalar (v0.29.0)

En modo Auto, los pedidos sin señales de dificultad los hace un modelo barato. Si ese intento **falla de forma verificable** (los cambios no se pudieron aplicar, o la verificación de sintaxis o `verifyCommand` no pasa), SovNode **deshace ese intento** y lo repite **una vez con el modelo fuerte**, pasándole el error para que no lo repita. Lo avisa en el chat.

- Los errores de red o de la API no escalan, porque no dicen nada sobre el modelo.
- Si el pedido ya parecía difícil, Auto va directo al fuerte y no hay intento barato.
- El intento fallido no queda en el historial.
- Se apaga con `sovnodeAider.autoEscalate: false`.

La verificación mira que compile y que pasen los tests. Sin tests (o sin `verifyCommand`), solo se revisa la sintaxis, así que un resultado que compila pero está mal no escala. Funciona mejor en proyectos con tests.
