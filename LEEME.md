# Analizador automático de repuestos

## Iniciar

1. Instalar Node.js 18 o superior.
2. Abrir una terminal en esta carpeta y ejecutar `npm start`.
3. Abrir `http://localhost:4173` en Chrome o Edge.
4. Crear una clave en [Google AI Studio](https://aistudio.google.com/apikey), pegarla en la barra fija y elegir la carpeta raíz de las fotos.
5. La app busca automáticamente un `.xlsx`, `.xls` o `.csv` junto al programa y en la carpeta raíz seleccionada. Lee la primera fila como encabezados; espera `Producto_ID`, `Marca`, `Modelo`, `Versión`, `Año` y `Motor`.
6. Elegir una carpeta de repuesto y pulsar **Generar ficha automática**.

La app analiza hasta diez fotos, redacta la ficha, investiga el código, propone una categoría de Mercado Libre y trae los atributos requeridos. Busca los vehículos en el Excel por marca/modelo/año/motor/versión y escribe cada coincidencia como `Producto_ID | Marca Modelo Año Versión Motor`.

## Título

Se compone priorizando pieza, marca/modelo compatible, cilindrada, años abreviados y lado abreviado (`DEL IZQ`, `DEL DER`, `TRAS IZQ`, `TRAS DER`). Termina en `USAD` y respeta el menor límite entre 60 caracteres y `max_title_length` de la categoría. La descripción incluye la compatibilidad completa encontrada.

Mercado Libre recomienda no poner la condición nuevo/usado en el título y mostrarla en las características. `USAD` se añadió porque forma parte del formato solicitado, pero podría ir contra esa recomendación.

## Publicar en Mercado Libre

1. Creá una aplicación en el DevCenter de Mercado Libre.
2. Registrá como URL de retorno la dirección exacta que muestra el modal (por defecto, `https://mercadolibre.com.ar`).
3. En el modal ingresá Client ID y Client Secret, registrá la misma Redirect URI HTTPS y activá PKCE solo si también está activado en DevCenter. Autorizá la cuenta y pegá la URL completa de retorno para finalizar. Las credenciales y tokens se mantienen en memoria y hay que reconectar si se reinicia el servidor.
4. Revisá el tipo de publicación disponible para tu cuenta y categoría, el precio, stock, condición, envío, SKU y ficha técnica. Las medidas deben ser las del paquete ya embalado y el peso se expresa en gramos; no se inventan desde fotos sin escala.
5. El botón sube las fotos y crea el ítem. La descripción se agrega en una segunda llamada; si esa llamada falla, el modal informa que el ítem ya se creó. Los videos no se suben todavía.

La asociación de compatibilidades por ID de vehículo no se envía a Mercado Libre en esta versión; se muestra como referencia y queda en la descripción si fue generada.
## Privacidad y límites

- Las fotos se envían a Gemini al generar la ficha. La clave se guarda solo en la sesión de esa pestaña y no se escribe en archivos del proyecto.
- El Excel se lee localmente y sus filas se usan para asociar IDs; no se envían a Gemini.
- Google indica que el contenido del nivel gratuito puede utilizarse para mejorar sus productos. Evitá usar fotos con datos sensibles.
- La cuota puede cambiar. Medidas y peso no se inventan: quedan vacíos si ninguna fuente confiable los informa.
- Los resultados web pueden ser incompletos. Revisá especialmente los años/motores y las IDs antes de publicar.
- La app todavía no asocia compatibilidades mediante el módulo de vehículos ni extrae fotogramas de videos.
