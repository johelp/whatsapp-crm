# WhatsFlow — Cumplimiento en Europa (RGPD, ePrivacy, Reglamento de IA, WhatsApp)

> **Informe técnico-jurídico preliminar — NO es asesoramiento legal.** Fecha de la investigación: 26/10/2026.
> Está pensado para que lo revise un abogado/DPO antes de operar con datos reales de la UE. Las fuentes secundarias (blogs de despachos y consultoras) están marcadas: hay que contrastarlas con el texto oficial (EUR-Lex / Diario Oficial) antes de decidir.
> Lo marcado **[verificar]** es una afirmación que no pude confirmar en una fuente oficial.

---

## 1. Resumen ejecutivo

| Tema | Estado | Riesgo |
|---|---|---|
| **Reglamento de IA, art. 50(1)** (avisar que se habla con una IA) | Vigente desde el **2/8/2026**. El producto **no lo cumple hoy**. | 🔴 Alto |
| **RGPD: derechos de los interesados** (acceso, supresión, portabilidad) | El borrado de un contacto **no elimina** sus mensajes, notas ni colas. No hay exportación. | 🔴 Alto |
| **ePrivacy / LSSI (España) — consentimiento para mensajes comerciales** | Sin registro de consentimiento. Las campañas solo respetan la lista de bloqueo. | 🔴 Alto |
| **Datos personales en logs** | Los logs contienen teléfonos y fragmentos de mensajes; Railway guarda logs en EE. UU. 90 días. | 🔴 Alto |
| **Región y transferencias** (Railway, proveedores de IA) | Región no fijada; proveedores de IA con endpoints globales/EE. UU. | 🟠 Medio-alto |
| **Retención / limitación del plazo** | Los mensajes se guardan indefinidamente. | 🟠 Medio |
| **Condiciones de WhatsApp** (modo no oficial) | Contraviene las condiciones de WhatsApp; riesgo de bloqueo y contractual. | 🟠 Medio-alto |
| **Seguridad (art. 32)** | Base razonable; faltan 2FA y cifrado de secretos en base. | 🟡 Medio |
| **Documentación** (RAT, EIPD, DPA, aviso legal) | Hay borradores de acuerdo y política; faltan RAT, EIPD y aviso legal. | 🟡 Medio |
| **Alfabetización en IA (art. 4)** | Sigue vigente, suavizada. | 🟡 Medio |

**Conclusión:** para un piloto con datos reales de ciudadanos de la UE, hay que cerrar antes al menos los puntos 🔴 y fijar la región. Ver la hoja de ruta (§8).

---

> **Actualización 26/10/2026 — estado de las correcciones de código P0:** ✅ implementadas y probadas (ver Anexo B). Siguen pendientes los puntos **no técnicos** de P0 (región EU West + DPA de Railway, revisión legal, RAT/EIPD, aviso legal) y todo P1.

---

## 2. Qué normas aplican y por qué

WhatsFlow es una plataforma de atención por WhatsApp: **cada cliente (empresa) es responsable del tratamiento** de los datos de sus clientes finales y **WhatsFlow actúa como encargado** (art. 28 RGPD). Para los usuarios del panel (operadores), WhatsFlow es responsable. Además:

- **RGPD** (Reglamento (UE) 2016/679) y normas nacionales (LOPDGDD en España; Codice Privacy en Italia, etc.).
- **ePrivacy** (Directiva 2002/58/CE, art. 13) y su transposición: en España, **art. 21 LSSI** y art. 38.4.d (infracción leve).
- **Reglamento de IA** (Reglamento (UE) 2024/1689), modificado por el *Digital Omnibus* (Reglamento (UE) 2026/1744).
- **Condiciones de WhatsApp / Meta** (contractuales, no legales, pero determinantes).
- **Transferencias internacionales** (cap. V RGPD).

---

## 3. Reglamento de IA

### 3.1 Calendario (según fuentes secundarias **[verificar en el Diario Oficial]**)
- **Art. 50 (transparencia):** obligaciones aplicables desde el **2/8/2026**. El Omnibus **no** retrasó la divulgación para chatbots; solo dio plazo hasta el **2/12/2026** para el marcado legible por máquina de contenido generado en sistemas ya comercializados antes del 2/8/2026.
- **Alto riesgo (Anexo III):** retrasado al **2/12/2027** (Anexo I: 2/8/2028).
- **Art. 4 (alfabetización en IA):** se mantiene para proveedores y desplegadores, **suavizada** («adoptar medidas para fomentar» la alfabetización, no «garantizar» un nivel). Control por autoridades nacionales desde el 2/8/2026.
- Las **directrices de la Comisión sobre el art. 50** (20/7/2026) son no vinculantes.

### 3.2 Roles
- **WhatsFlow = proveedor** de un sistema de IA (chatbot de atención) que integra modelos de terceros (OpenAI, Anthropic, Google, Groq: proveedores de modelos de uso general).
- **Cada cliente = desplegador.**

### 3.3 Obligaciones y brechas

| Requisito | Qué exige | Estado del producto |
|---|---|---|
| **Art. 50(1)** | Los sistemas destinados a interactuar directamente con personas deben diseñarse para que **se informe que están hablando con una IA**, salvo que sea evidente. | ❌ **No cumple.** La IA responde como si fuera una persona. |
| Art. 50(2) | Marcado de contenido sintético en formato legible por máquina (texto generado). Alcance sobre chatbots conversacionales **[verificar con las directrices]**. | ⚠ Evaluar; hay plazo hasta 2/12/2026 para sistemas previos. |
| **Art. 4** | Medidas de alfabetización en IA del personal que opera/supervisa la IA. | ⚠ Falta una guía para operadores (la incluye el manual §Funciones de IA a crear). |
| Prácticas prohibidas (art. 5) | Entre otras, reconocimiento de emociones en el **trabajo y la educación**. | ✅ No aplica: la clasificación de sentimiento es sobre **texto** de clientes, no biométrica ni laboral. **[verificar con un abogado]** |
| Alto riesgo | Sistemas de reconocimiento de emociones **biométricos**, empleo, crédito, etc. | ✅ El producto no está en esos casos mientras no se use para decisiones sobre empleo, crédito o acceso a servicios esenciales. Documentar el uso previsto y **prohibirlo** en los términos. |

### 3.4 Qué hay que construir
1. **Aviso de IA configurable**: el primer mensaje de la IA en cada conversación incluye una frase («Soy un asistente virtual de [empresa]. Puedes pedir hablar con una persona en cualquier momento.»), en el idioma del cliente. Activado por defecto, no desactivable en instalaciones de la UE.
2. **Salida a un humano** siempre disponible y anunciada (el handoff existe por palabras clave; hay que anunciarlo).
3. **Registro** de cuándo respondió la IA (ya se distingue con `sent_by` nulo; falta marcarlo de forma explícita en la base y en la exportación).
4. **Guía de alfabetización** para operadores (límites de la IA, revisión humana, qué no pedirle).
5. **Cláusula de uso prohibido** en los términos: sin decisiones automatizadas sobre empleo, crédito, seguros, salud o acceso a servicios esenciales.

---

## 4. RGPD

### 4.1 Decisiones automatizadas y perfilado (art. 22)
- La clasificación (intención, prioridad, sentimiento) y la asignación automática son **perfilado** (art. 4(4)) de bajo impacto: sirven para ordenar y repartir conversaciones.
- El art. 22 aplica a decisiones **exclusivamente automatizadas con efectos jurídicos o similares** (TJUE, *SCHUFA*, C-634/21, 7/12/2023: el *scoring* que determina la decisión se considera decisión automatizada). Priorizar un chat **no** debería alcanzarlo **[verificar]**, siempre que un humano siga decidiendo.
- **Medidas:** informar del perfilado en la política de privacidad del cliente, mantener revisión humana, no usar la clasificación para denegar servicio o precio, y permitir **desactivar la clasificación por contacto** (oposición, art. 21).

### 4.2 Base jurídica de la IA (EDPB, Dictamen 28/2024)
- El interés legítimo **no es una base por defecto** para tratamiento con IA: exige prueba de **necesidad, proporcionalidad y ponderación**, y tener en cuenta las expectativas razonables de los interesados. El cliente debe documentar su ponderación (EIPD / test de interés legítimo) cuando use IA con datos de clientes.
- Texto del dictamen: debe consultarse directamente (los resúmenes que encontré no tratan chatbots de atención).

### 4.3 Derechos de los interesados — **brecha crítica**
| Derecho | Hoy | Falta |
|---|---|---|
| Acceso / portabilidad (arts. 15, 20) | Ninguna exportación por persona | Exportar **todo** lo de un contacto en JSON/CSV |
| Supresión (art. 17) | `DELETE /contacts/:id` borra solo la fila del contacto; **quedan** mensajes, conversación, notas, resumen de IA, etiquetas, filas de campañas y de la cola | Borrado **completo** por teléfono/JID, con registro de auditoría |
| Oposición (art. 21) | «STOP» → lista de bloqueo ✔ | Opción por contacto para excluirlo de IA/clasificación |
| Rectificación (art. 16) | Edición de contactos ✔ | — |

También: los **respaldos** conservan datos «borrados» hasta 7 días: documentarlo y, ante una supresión, asegurar que no se restauren sin volver a aplicarla.

### 4.3.1 Retención (art. 5(1)(e))
Hoy los mensajes se guardan **indefinidamente**. Hace falta una política configurable (p. ej. 12–24 meses) con borrado automático de mensajes, cola de salida, entregas de webhooks, registros de actividad y respaldos antiguos, y una nota sobre lo que el cliente debe conservar por obligación legal.

### 4.4 Información y transparencia (arts. 13–14)
- El cliente debe informar a sus clientes de que usa WhatsFlow, de la IA, del perfilado y de los encargados. Proveer **textos modelo** y un **enlace opcional a la política de privacidad** en el primer mensaje automático.
- La **transcripción de audios** es tratamiento de datos personales (la voz). WhatsFlow **no guarda el audio**, solo el texto: bien. Debe informarse al interesado.

### 4.5 Datos personales en los logs — **brecha crítica**
El código imprime en el log números de teléfono y los primeros 60 caracteres de mensajes (`[AI v2…]`, `[fromDevice]`, resúmenes de conversaciones, etc.). **Railway guarda los logs en EE. UU. durante 90 días y no permite borrar entradas individuales** (foro oficial; **[verificar en su DPA]**). Hay que eliminar contenido y enmascarar teléfonos en los logs.

### 4.6 Seguridad (art. 32)
✅ HTTPS, contraseñas con hash, roles, límite de intentos, claves de API con hash, respaldos, anti-SSRF, sesiones `httpOnly`/`secure`.
⚠ Pendiente: **2FA** para administradores, **cifrado en reposo de secretos** guardados en base (clave de IA, secretos de webhooks), tiempo de expiración/cierre de sesión más corto, registro de auditoría de acciones de admin (exportar, borrar, ver respaldos), política de contraseñas, y procedimiento de **notificación de brechas en 72 horas** (arts. 33–34).

### 4.7 Documentos obligatorios
- **Registro de actividades de tratamiento** (art. 30) — plantilla en el Anexo A.
- **EIPD** (art. 35): probablemente recomendable para el cliente por el uso de IA con mensajería a gran escala **[verificar con DPO]**.
- **Acuerdo de encargo (art. 28):** borrador en `ACUERDO_PILOTO.md` (Anexo I). Debe incluir subencargados, transferencias, asistencia en derechos, auditoría y devolución/borrado.
- **DPO:** evaluar si es obligatorio (tratamiento a gran escala / seguimiento regular) **[verificar]**.

---

## 5. ePrivacy / LSSI — mensajes comerciales por WhatsApp

- En España, el **art. 21 LSSI** prohíbe comunicaciones comerciales por «correo electrónico u otro medio de comunicación electrónica equivalente» **no solicitadas o no autorizadas expresamente**; la AEPD y INCIBE incluyen **WhatsApp**. La AEPD ha rechazado el consentimiento tácito. Excepción (art. 21.2): cliente previo y **productos o servicios similares**, con oposición fácil y gratuita en cada envío. Sanciones documentadas por añadir contactos a un grupo con fines comerciales (4.000 €) o por envíos sin cumplir los requisitos (5.000 €, infracción leve) — fuentes secundarias, **[verificar resoluciones vigentes]**.
- Otros Estados (Italia: art. 130 Codice Privacy; Francia: CPCE) tienen reglas análogas, con matices (*soft opt-in*).
- **Brechas del producto:** no se guarda el consentimiento (fecha, origen, texto), las campañas no distinguen contactos con consentimiento, y la importación CSV no pide declaración de legitimidad.
- **Qué construir:** campo de **consentimiento** por contacto (estado, fecha, origen, evidencia), exigencia de consentimiento/relación previa para **campañas**, casilla de confirmación al **importar CSV**, pie de baja («Responde BAJA para no recibir más») opcional en cada campaña, y registro de bajas.

---

## 6. WhatsApp / Meta

- **Modo no oficial (hoy):** las condiciones de WhatsApp restringen la automatización y los mensajes masivos fuera de su API **[verificar texto vigente]**. Riesgo: bloqueo y reclamación contractual; no es un incumplimiento del RGPD en sí, pero un número bloqueado interrumpe la atención al cliente. **Debe aceptarse por escrito** (ya está en el borrador del acuerdo, cláusula 3) y no recomendarse para volumen o cuentas críticas.
- **API oficial (WhatsApp Business Platform):** Meta exige *opt-in* y plantillas, y aplica sus propias condiciones de datos. **Política de IA de Meta:** desde el **15/1/2026** Meta prohíbe en la API de empresa los **asistentes de IA de propósito general** como servicio principal; los **bots de atención al cliente** donde la IA es accesoria **siguen permitidos**. La Comisión Europea abrió una investigación antitrust (4/12/2025) y ordenó **medidas cautelares** (Meta anunció que apelará). Para WhatsFlow, que es atención al cliente, **no debería verse afectado**, pero hay que **vigilar** cambios (fuentes secundarias, **[verificar]**).
- **Recomendación:** para clientes de la UE con volumen, **API oficial** (prevista) como camino de producción; el modo QR, solo para pilotos con aceptación expresa.

---

## 7. Hosting, subencargados y transferencias

### 7.1 Railway
- Región **«EU West» (Ámsterdam)** disponible para servicios y volúmenes; los respaldos de volumen quedan en esa región.
- **Logs de aplicación, despliegue, build y HTTP se almacenan en EE. UU. (US West) aunque el servicio esté en la UE**, con retención de 90 días (foro oficial; **[verificar]**).
- Railway **no ofrece compromiso contractual de residencia** en la UE en ningún plan; solo su DPA estándar (railway.com/legal/dpa) con lista de subencargados en trust.railway.com.
- **Hoy:** la región **no está fijada** en nuestra instalación (probablemente EE. UU.; verificar en el panel → Settings → Deploy). **Acción:** crear/migrar las instalaciones de clientes de la UE a **EU West**, firmar el DPA de Railway y reflejarlo como subencargado.

### 7.2 Proveedores de IA (el cliente usa su propia API key)
| Proveedor | Residencia UE | Nota |
|---|---|---|
| **OpenAI** | Sí, en la API con **Projects de región Europa** (procesamiento en la UE, retención cero) | Requiere crear un proyecto nuevo con región Europa **[verificar elegibilidad]** |
| **Anthropic** | Sin región UE propia; vía **AWS Bedrock (UE)** | Nuestra integración usa la API directa → datos en EE. UU. |
| **Google Gemini** | La API de desarrolladores/AI Studio es global; UE vía **Vertex AI** | Nuestra integración usa AI Studio |
| **Groq** | **[verificar]** | Documentar región |

Fuente: comparativas de 2026 (secundarias). **Acción:** documentar la región por proveedor en la interfaz de IA («tus datos se procesan en EE. UU./UE»), ofrecer configuración de **endpoint regional** donde exista y recomendar a los clientes de la UE el proveedor con proceso en la UE.

### 7.3 Transferencias a EE. UU.
- El **Marco de Privacidad de Datos UE-EE. UU. (DPF)** sigue vigente: el Tribunal General lo confirmó el 3/9/2025 (*Latombe*), y el **recurso (C-703/25 P) sigue pendiente** ante el TJUE (sin fecha de sentencia **[verificar]**). Mientras tanto, mantener **cláusulas contractuales tipo (SCC)** como respaldo y una **evaluación de impacto de la transferencia** documentada; por el *CLOUD Act*, alojar en la UE no elimina del todo el riesgo de acceso de autoridades estadounidenses.

---

## 8. Hoja de ruta

### P0 — antes de operar con datos reales de la UE (≈ 2–4 días de desarrollo + trámites)
| # | Acción | Tipo | Esfuerzo |
|---|---|---|---|
| 1 | **Aviso de IA** (art. 50(1)) en el primer mensaje y salida a humano anunciada | Código | 0,5 d |
| 2 | **Borrado completo y exportación por contacto** (arts. 15, 17, 20) con auditoría | Código | 1 d |
| 3 | **Consentimiento**: campo, origen, fecha; guard en campañas; casilla en CSV; baja en campañas | Código | 1 d |
| 4 | **Quitar datos personales de los logs** (teléfonos enmascarados, sin texto) | Código | 0,25 d |
| 5 | **Política de retención** configurable + purga automática | Código | 0,5 d |
| 6 | **Región EU West** para instalaciones de la UE + DPA de Railway + lista de subencargados | Infra/legal | 0,5 d |
| 7 | **Revisión legal** de acuerdo/DPA/política/aviso legal por un abogado de la UE | Legal | — |
| 8 | **Registro de actividades (RAT)** y **EIPD** del piloto | Legal | 0,5 d |
| 9 | **Aviso legal** (LSSI art. 10: razón social, NIF, domicilio, contacto) en la landing | Contenido | 0,25 d |

### P1 — primer trimestre
- 2FA para administradores; cifrado en reposo de secretos; expiración de sesión; registro de auditoría completo.
- Selector de **región del proveedor de IA** y soporte de **Bedrock/Vertex/OpenAI-Europa**.
- **Guía de alfabetización en IA** para operadores y textos modelo de información al cliente final.
- Opción «no clasificar con IA» por contacto.
- Procedimiento y formulario de **brechas (72 h)**.
- Captura de **consentimiento** desde el propio chat (respuesta a un mensaje de alta) y desde formularios web vía API.
- **API oficial de Meta** como proveedor de conexión.

### P2
- Certificación/auditoría de seguridad (p. ej. ENS en España o ISO 27001) si se vende a administraciones o grandes cuentas.
- Evaluar si el cliente necesita DPO y EIPD ampliada.

---

## 9. Textos modelo para el cliente (a adaptar)

**Primer mensaje automático con IA:**
> «Hola, soy el asistente virtual de [empresa]. Te ayudo con tu consulta y, si prefieres, te paso con una persona escribiendo “persona”. Más información sobre cómo tratamos tus datos: [enlace].»

**Pie de campaña (cuando corresponda):**
> «Para dejar de recibir estos mensajes, responde BAJA.»

**Cláusula para el cliente final (alta de consentimiento):**
> «Acepto recibir comunicaciones comerciales de [empresa] por WhatsApp. Puedo darme de baja cuando quiera respondiendo BAJA.»

---

## Anexo A — Registro de actividades de tratamiento (plantilla, encargado)

| Campo | Contenido |
|---|---|
| Responsable (cliente) | [datos] |
| Encargado | [razón social del proveedor] |
| Categorías de tratamiento | Alojamiento y gestión de conversaciones de atención; clasificación y respuestas asistidas por IA; campañas; notas internas; respaldos |
| Categorías de datos / interesados | Identificación y contacto, contenido de mensajes, notas / clientes finales y operadores |
| Subencargados | Railway Corp. (alojamiento); proveedor de IA elegido por el cliente; [otros] |
| Transferencias | [EE. UU. por proveedor de IA / logs de Railway] — SCC / DPF |
| Plazos de supresión | [definidos por el cliente; por defecto 12–24 meses] |
| Medidas de seguridad | Ver §4.6 |

---

## Fuentes consultadas (secundarias salvo indicación)

- Reglamento de IA y Omnibus: [Usercentrics](https://usercentrics.com/knowledge-hub/eu-ai-act-high-risk-delay-article-50-transparency-consent/), [Jones Walker](https://www.joneswalker.com/en/insights/blogs/ai-law-blog/yes-august-2-still-matters-the-eu-approved-a-high-risk-ai-delay-but-most-trans.html), [Legalithm](https://www.legalithm.com/en/blog/eu-ai-act-what-applies-2-august-2026), [Cloud Security Alliance](https://labs.cloudsecurityalliance.org/research/csa-research-note-eu-ai-act-article-50-transparency-20260729/), [Vizio](https://www.vizio.ai/resources/blog/eu-ai-act-article-50)
- Alfabetización en IA (art. 4): [KI-Campus](https://ki-campus.org/en/blog/eu-ai-act-ai-omnibus-recalibrates-article-4-ai-literacy-remains-mandatory)
- WhatsApp y IA / Comisión Europea: [TechCrunch (4/12/2025)](https://techcrunch.com/2025/12/04/eu-investigating-meta-over-policy-change-that-bans-rival-ai-chatbots-from-whatsapp/), [TechRadar](https://www.techradar.com/pro/eu-launches-antitrust-investigation-into-metas-whatsapp-ai-access-policy), [Slashdot](https://meta.slashdot.org/story/26/06/09/1958236/eu-orders-meta-to-open-whatsapp-to-rival-ai-chatbots)
- DPF / *Latombe*: [WilmerHale](https://www.wilmerhale.com/en/insights/blogs/wilmerhale-privacy-and-cybersecurity-law-blog/20251201-european-court-of-justice-to-review-challenge-to-eu-us-data-privacy-framework), [Digital Policy Alert](https://digitalpolicyalert.org/event/35459-latombe-filed-appeal-against-general-court-dismissal-of-challenge-to-european-unionunited-states-data-protection-framework-adequacy-decision-in-latombe-v-commission)
- LSSI / AEPD / WhatsApp: [INCIBE](https://www.incibe.es/empresas/blog/utiliza-whatsapp-tu-empresa-cumpliendo-el-rgpd-y-lopdgdd), [AEPD (informe 2018)](https://www.aepd.es/documento/2018-0173.pdf), [AEPD (resolución 2017)](https://www.aepd.es/es/documento/e-04215-2017.pdf)
- EDPB, Dictamen 28/2024: [CMS](https://cms.law/en/int/legal-updates/edpb-opinion-28-2024-key-takeaways-on-processing-personal-data-in-the-context-of-ai-models)
- Art. 22 y *SCHUFA*: [A&O Shearman](https://www.aoshearman.com/en/insights/ao-shearman-on-data/cjeu-rules-that-a-credit-score-constitutes-automated-decision-making-under-the-gdpr), [Cloisters](https://www.cloisters.com/latest/cjeus-first-ruling-on-article-22-gdpr-credit-scoring-is-an-automated-decision)
- Railway (región, logs, DPA): [DPA oficial](https://railway.com/legal/dpa), foros de soporte: [logs y DPA](https://station.railway.com/questions/log-retention-and-data-processing-agreem-223bf7c1), [EU West](https://station.railway.com/questions/dpa-point-9-can-audio-uploaded-to-my-e-2d648493)
- Residencia de datos de proveedores de IA: [OpenAI (TechCrunch)](https://techcrunch.com/2025/02/06/openai-launches-data-residency-in-europe), [Eden AI](https://www.edenai.co/post/how-to-use-openai-claude-gemini-in-europe-without-gdpr-risk), [First AI Movers](https://radar.firstaimovers.com/ai-data-residency-guide-european-smes-2026)


---

## Anexo B — Estado de implementación (P0 de código)

| # | Corrección | Estado | Dónde |
|---|---|---|---|
| 1 | **Aviso de IA (art. 50.1)** en la primera respuesta de cada conversación; salida a humano con la palabra «persona»; mensajes de la IA marcados en la base (`is_auto_reply`) | ✅ | Configuración → Privacidad · `backend/ai-agent.js`, `privacy.js` · `AI_DISCLOSURE_LOCKED=true` impide apagarlo |
| 2 | **Búsqueda, exportación (JSON) y borrado completo por titular**; anonimización en grupos; registro de borrados con identificador cifrado; reaplicación al restaurar respaldos (`--erasures`) | ✅ | Configuración → Privacidad · `backend/dsr.js`, `scripts/restore-backup.js` |
| 3 | **Consentimiento**: estado, origen y fecha por contacto; las campañas exigen consentimiento (configurable, nunca a quien se dio de baja); declaración del operador al importar listas; «BAJA» revoca; pie de baja en campañas; comprobación previa al iniciar | ✅ | Contactos, campañas y Configuración → Privacidad · `backend/antiban.js`, `privacy.js`, `sender.js` |
| 4 | **Logs sin datos personales**: teléfonos enmascarados y sin contenido de mensajes | ✅ | `backend/redact.js` y logs de IA, WhatsApp, campañas |
| 5 | **Retención** configurable con purga nocturna y vista previa | ✅ | Configuración → Privacidad · `backend/privacy.js` (cron 03:45) |

**Límites conocidos (documentar al cliente):**
- Los **respaldos** conservan datos hasta 7 días; al restaurar, aplicar la lista de eliminaciones.
- La **purga por retención no borra contactos** (la libreta de direcciones es decisión del cliente) ni los respaldos.
- El aviso de IA se envía **una vez por conversación** (no se repite tras largas pausas) y está en el idioma que configure el cliente.
- La clasificación de sentimiento/prioridad no tiene todavía opción «no clasificar a este contacto» (P1).
- La **región de despliegue** y los **proveedores de IA** siguen siendo responsabilidad de la configuración (P0 no técnico, §7).
