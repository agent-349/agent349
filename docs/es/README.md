# Documentación de referencia (español)

Manuales de referencia completos de Agent349, escritos durante el desarrollo del
SDK. La documentación principal está en inglés en [`docs/`](../README.md); estos
manuales conservan el detalle exhaustivo de cada módulo.

| Manual | Tema |
|---|---|
| [USER_MANUAL.md](USER_MANUAL.md) | Guía transversal: conceptos, LLM, RAG, seguridad, auditoría, HITL |
| [TOOLS_MANUAL.md](TOOLS_MANUAL.md) | Tools de integración: conexiones, credenciales, SQL, HTTP, web, documentos, mail |
| [RAG_MANUAL.md](RAG_MANUAL.md) | Ingesta y recuperación |
| [ACL_MANUAL.md](ACL_MANUAL.md) | Control de acceso y pipeline de seguridad |
| [AUDIT_MANUAL.md](AUDIT_MANUAL.md) | Auditoría funcional |
| [HITL_MANUAL.md](HITL_MANUAL.md) | Human-in-the-loop en producción |
| [MCP_MANUAL.md](MCP_MANUAL.md) | Cliente MCP |
| [MEMORY_MANUAL.md](MEMORY_MANUAL.md) | Memoria de sesión, largo plazo y semántica |
| [TOKENS_MANUAL.md](TOKENS_MANUAL.md) | Consumo de tokens y observabilidad |
| [LOGGING_MANUAL.md](LOGGING_MANUAL.md) | Logging técnico |
| [CLUSTER_MANUAL.md](CLUSTER_MANUAL.md) | Despliegue multi-instancia |
| [MULTIMODAL_MANUAL.md](MULTIMODAL_MANUAL.md) | Contenido multimodal, archivos y structured output |
| [BATCH_MANUAL.md](BATCH_MANUAL.md) | Procesamiento batch |
| [MIGRATION_0.3.md](MIGRATION_0.3.md) | Migración a 0.3 |
| [critical-tests.md](critical-tests.md) | Casos de test que fijan decisiones de diseño (registro histórico) |

> Ante cualquier diferencia entre estos manuales y el código, manda el código
> (`src/` y `tests/`). Los ejemplos de código de la documentación en inglés se
> verifican automáticamente contra el código; los de estos manuales no.
