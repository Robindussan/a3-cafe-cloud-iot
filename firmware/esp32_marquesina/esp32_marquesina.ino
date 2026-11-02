/*
  ============================================================================
  Nodo de monitoreo del secado de café en marquesinas — ESP32-C3 SuperMini
  Curso: Integración Cloud en IoT — CORHUILA — Actividad 3 (proyecto integrador)
  Autor: Robin Mauricio Dussán Medina
  ----------------------------------------------------------------------------
  Un solo montaje físico se presenta ante el broker como TRES marquesinas
  (marquesina-01, -02 y -03): tres clientes MQTT independientes, cada uno con su
  propia conexión TLS, client_id, usuario, clave, última voluntad (LWT) y tópicos.
  Las marquesinas 02 y 03 aplican un desfase fijo y un ruido pequeño sobre la
  lectura real para que sus series no sean idénticas (ver DESFASES).

  Hardware:
    GPIO2  -> DHT22 (temperatura y humedad relativa dentro de la marquesina)
    GPIO0  -> MQ-7  (monóxido de carbono, salida analógica AO)
    GPIO1  -> LDR   (divisor: LDR a GND, 20 kΩ a 3,3 V; luz solar)
    SDA/SCL (GPIO8 / GPIO9) -> RTC DS3231 (I2C), guarda la hora en UTC

  Flujo:  sensores -> JSON -> MQTT/TLS 8883 -> NanoMQ (Raspberry, fog)
                                   -> bridge TLS -> EMQX (mqtt.agrotecnet.cloud)
  Tópicos por marquesina (<id> = marquesina-0x):
      cafe/<id>/telemetria  (QoS 0)            lecturas en JSON
      cafe/<id>/estado      (QoS 1, retenido)  online / offline (última voluntad)
      cafe/<id>/cmd         (QoS 1)            comandos desde la nube

  Optimización (banda muerta): cada marquesina solo publica cuando una variable
  cambia más que su umbral, o cuando vence el latido (por defecto 5 min). Se puede
  activar o desactivar en caliente para medir el antes/después.

  Librerías (Gestor de librerías del IDE de Arduino):
    PubSubClient 2.8 (Nick O'Leary) · ArduinoJson 7.x (Benoît Blanchon)
    DHT sensor library 1.4.x + Adafruit Unified Sensor · RTClib 2.1.x (Adafruit)
  Placa: "ESP32C3 Dev Module" (núcleo esp32 de Espressif 3.x)
         Herramientas -> USB CDC On Boot: "Enabled" (para ver el monitor serie)
  Archivos locales: secrets.h (de secrets.h.example) y ca_fog.h (Fase 2).
  ============================================================================
*/

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <DHT.h>
#include <Wire.h>
#include <RTClib.h>
#include <time.h>
#include <sys/time.h>
#include <math.h>
#include "esp_sntp.h"

#include "secrets.h"   // WiFi, broker, NTP y usuarios MQTT (no se versiona)
#include "ca_nube.h"   // ISRG Root X1 (modo de prueba contra mqtt.agrotecnet.cloud)
#if __has_include("ca_fog.h")
#include "ca_fog.h"    // CA de la finca (la genera la Fase 2)
#define HAY_CA_FOG 1
#endif

// ---------------------------------------------------------------- Identidad
#define FW_VERSION   "3.0.4"

#ifdef MODO_PRUEBA_NUBE
#define TOPIC_RAIZ   "prueba/cafe/"
#define MODO         "nube-prueba"
static const char* CA_BROKER = CA_NUBE_PEM;
#else
#define TOPIC_RAIZ   "cafe/"
#define MODO         "fog"
#ifdef HAY_CA_FOG
static const char* CA_BROKER = CA_FOG_PEM;
#else
static const char* CA_BROKER = nullptr;   // sin ca_fog.h no se puede verificar al NanoMQ
#endif
#endif

// ---------------------------------------------------------------- Pines
#define PIN_DHT   2
#define PIN_MQ7   0     // ADC1_CH0
#define PIN_LDR   1     // ADC1_CH1
#define PIN_SDA   8
#define PIN_SCL   9

// ---------------------------------------------------------------- Calibración
// MQ-7: el módulo se alimenta a 5 V y su salida AO puede superar 3,3 V.
// Se recomienda un divisor 10 kΩ / 20 kΩ entre AO y GPIO0 -> factor 1,5.
// Si alimenta el módulo a 3,3 V o no usa divisor, deje el factor en 1.0.
const float MQ7_FACTOR_DIVISOR = 1.0f;
const float MQ7_VC   = 5.0f;     // tensión del circuito del sensor (V)
const float MQ7_RL   = 10.0f;    // resistencia de carga del módulo (kΩ)
float       mq7_R0   = 10.0f;    // Rs en aire limpio (kΩ). Se ajusta con el comando "calibrar_mq7"
// Curva de la hoja de datos (Hanwei) aproximada: ppm = A * (Rs/R0)^B
const float MQ7_A = 99.042f;
const float MQ7_B = -1.518f;

// LDR (tipo GL55xx) en divisor: resistencia fija de 20 kΩ a 3,3 V y LDR a GND; GPIO1 mide el
// voltaje sobre la LDR (más luz -> menos voltaje). Medida con multímetro: ~22 kΩ en oscuridad y
// ~132 Ω con luz fuerte. Verificado tapando e iluminando la LDR. Si se arma al revés (LDR a 3,3 V),
// poner LDR_A_GND en false.
// Límite: con 20 kΩ y luz fuerte el voltaje baja a ~0,02 V, bajo el piso del ADC del ESP32-C3
// (~0,1 V), así que la lectura satura cerca de 1 klx. Con 2,2 kΩ se mediría hasta ~9 klx.
const bool  LDR_A_GND    = true;
const float LDR_R_FIJA_K = 20.0f;   // kΩ
const float LDR_R10_K    = 15.0f;   // resistencia de la LDR a 10 lux (kΩ)
const float LDR_GAMMA    = 0.7f;
const float VCC_ADC      = 3.3f;

// ---------------------------------------------------------------- Marquesinas
// Desfase fijo respecto a la lectura real (temperatura °C, HR %, factor de luz, CO ppm)
// y amplitud del ruido uniforme. El ruido es menor que la banda muerta para que no
// provoque publicaciones por sí solo.
struct Desfase { float temp, hr, factorLux, co; };
const Desfase DESFASES[3] = {
  {  0.0f,  0.0f, 1.00f,  0.0f },   // marquesina-01: lectura real
  {  1.2f, -3.0f, 0.85f,  0.5f },   // marquesina-02: más caliente y seca, algo de sombra
  { -0.8f,  2.5f, 1.10f, -0.3f },   // marquesina-03: más fresca y húmeda, más expuesta
};
const float RUIDO_TEMP = 0.10f, RUIDO_HR = 0.30f;

struct Nodo {
  const char*      id;
  const char*      usuario;
  const char*      clave;
  WiFiClientSecure red;
  PubSubClient     mqtt;
  char             tTelemetria[48];
  char             tEstado[48];
  char             tCmd[48];
  uint32_t         seq = 0;
  uint32_t         enviados = 0;     // mensajes de telemetría publicados desde el arranque
  uint32_t         bytes = 0;        // bytes de carga útil publicados
  unsigned long    ultimoEnvio = 0;
  bool             forzar = false;
  // Banda muerta
  bool             banda = true;
  float            umbralTemp = 0.3f, umbralHr = 1.0f, umbralLuzPct = 15.0f, umbralCo = 5.0f;
  unsigned long    latidoMs = 300000;
  bool             hayPrevio = false;
  bool             pDhtOk = false;    // si la última publicación llevaba temperatura y HR
  float            pTemp = 0, pHr = 0, pLux = 0, pCo = 0;
};
Nodo nodos[3];

// ---------------------------------------------------------------- Objetos
DHT          dht(PIN_DHT, DHT22);
RTC_DS3231   rtc;

bool          rtcOk          = false;
unsigned long periodoMs      = 10000;   // muestreo de sensores (10 s por defecto)
unsigned long ultimaLectura  = 0;
unsigned long ultimoIntento  = 0;
uint8_t       siguienteNodo  = 0;
uint8_t       fallosSeguidos = 0;      // intentos MQTT fallidos sin ningún éxito entre medio
const uint8_t FALLOS_REINICIO_WIFI = 6; // con la WiFi "conectada" pero sin enlace real, se reasocia
volatile bool ntpSincronizado = false;   // lo marca el callback de SNTP; el RTC se ajusta en loop()
bool          horaNTP         = false;   // hubo al menos una sincronización NTP desde el arranque
const unsigned long ESPERA_NTP_MS = 60000;   // sin NTP en este tiempo se confía en el DS3231

struct Lectura { bool dhtOk; float temp, hr, lux, co; };

// ============================================================================
// Utilidades
// ============================================================================
float redondear(float v, int dec) {
  float p = powf(10.0f, dec);
  return roundf(v * p) / p;
}

float ruido(float amplitud) {
  return ((float)(esp_random() % 2001) / 1000.0f - 1.0f) * amplitud;
}

bool horaValida() {
  return time(nullptr) > 1700000000;
}

// La hora del DS3231 puede venir corrida (batería, zona horaria guardada por otro
// firmware): se espera al NTP del fog y solo si no llega se confía en el RTC.
bool horaConfiable() {
  return horaValida() && (horaNTP || millis() > ESPERA_NTP_MS);
}

// Marca de tiempo en milisegundos UTC (época Unix). 0 si aún no hay hora confiable.
uint64_t marcaTiempoMs() {
  if (!horaConfiable()) return 0;
  struct timeval tv;
  gettimeofday(&tv, nullptr);
  return (uint64_t)tv.tv_sec * 1000ULL + tv.tv_usec / 1000;
}

// ============================================================================
// Hora: NTP del fog -> reloj del sistema -> DS3231 (UTC). Sin NTP, el DS3231
// inicializa el reloj del sistema para que las marcas de tiempo sigan siendo válidas.
// ============================================================================
void alSincronizarNTP(struct timeval* tv) {
  ntpSincronizado = true;
}

void iniciarHora() {
  if (rtcOk && !rtc.lostPower()) {
    struct timeval tv = { (time_t)rtc.now().unixtime(), 0 };
    settimeofday(&tv, nullptr);
    Serial.printf("[RTC] Hora inicial desde el DS3231: %lu (UTC)\n", (unsigned long)tv.tv_sec);
  } else if (rtcOk) {
    Serial.println(F("[RTC] El DS3231 perdió la hora (batería); se esperará al NTP"));
  }
  sntp_set_time_sync_notification_cb(alSincronizarNTP);
  configTime(0, 0, NTP_SERVER);   // UTC; SNTP se resincroniza solo cada hora
}

void ajustarRTCdesdeNTP() {
  if (!ntpSincronizado) return;
  ntpSincronizado = false;
  horaNTP = true;
  time_t ahora = time(nullptr);
  if (rtcOk) rtc.adjust(DateTime((uint32_t)ahora));
  Serial.printf("[NTP] Hora sincronizada con %s: %lu (UTC)%s\n", NTP_SERVER,
                (unsigned long)ahora, rtcOk ? ", DS3231 ajustado" : "");
}

// ============================================================================
// Lectura de sensores (una vez por ciclo; las tres marquesinas parten de ella)
// ============================================================================
uint32_t leerMilivoltios(uint8_t pin, uint8_t muestras = 16) {
  uint32_t suma = 0;
  for (uint8_t i = 0; i < muestras; i++) {
    suma += analogReadMilliVolts(pin);
    delay(2);
  }
  return suma / muestras;
}

float mq7Resistencia(float vSensor) {
  if (vSensor < 0.01f) vSensor = 0.01f;
  return MQ7_RL * (MQ7_VC - vSensor) / vSensor;  // Rs en kΩ
}

float mq7Ppm(float rs) {
  float ppm = MQ7_A * powf(rs / mq7_R0, MQ7_B);
  if (ppm < 0) ppm = 0;
  if (ppm > 2000) ppm = 2000;
  return ppm;
}

Lectura leerSensores() {
  Lectura l;
  l.temp  = dht.readTemperature();
  l.hr    = dht.readHumidity();
  // Recién encendido (o con una trama mala) el DHT22 puede devolver 0,0 en vez de NaN:
  // una marquesina con 0 °C y 0 % HR no es física, se trata como lectura fallida.
  l.dhtOk = !(isnan(l.temp) || isnan(l.hr) || (l.temp == 0.0f && l.hr == 0.0f));
  static unsigned long ultimoAviso = 0;
  if (!l.dhtOk && (ultimoAviso == 0 || millis() - ultimoAviso > 60000)) {
    ultimoAviso = millis();
    Serial.printf("[DHT22] Lectura fallida (%s): revise el cable de datos en GPIO%d, VCC y GND\n",
                  isnan(l.temp) || isnan(l.hr) ? "sin respuesta, NaN" : "trama en 0,0", PIN_DHT);
  }

  float vMq7 = leerMilivoltios(PIN_MQ7) * MQ7_FACTOR_DIVISOR / 1000.0f;
  l.co = mq7Ppm(mq7Resistencia(vMq7));

  float vLdr  = leerMilivoltios(PIN_LDR) / 1000.0f;
  vLdr = constrain(vLdr, 0.01f, VCC_ADC - 0.01f);
  float rLdrK = LDR_A_GND ? LDR_R_FIJA_K * vLdr / (VCC_ADC - vLdr)     // LDR entre GPIO1 y GND
                          : LDR_R_FIJA_K * (VCC_ADC - vLdr) / vLdr;    // LDR entre 3,3 V y GPIO1
  l.lux = min(10.0f * powf(LDR_R10_K / max(rLdrK, 0.01f), 1.0f / LDR_GAMMA), 100000.0f);
  return l;
}

// ============================================================================
// Publicación
// ============================================================================
void publicarEstado(Nodo& n) {
  JsonDocument doc;
  doc["id"]        = n.id;
  doc["estado"]    = "online";
  doc["ts"]        = marcaTiempoMs();
  doc["fw"]        = FW_VERSION;
  doc["modo"]      = MODO;
  doc["ip"]        = WiFi.localIP().toString();
  doc["rssi"]      = WiFi.RSSI();
  doc["heap"]      = ESP.getFreeHeap();
  doc["periodo_s"] = periodoMs / 1000;
  doc["banda"]     = n.banda;
  doc["latido_s"]  = n.latidoMs / 1000;
  doc["enviados"]  = n.enviados;
  doc["rtc"]       = rtcOk ? "ok" : "falla";
  char buf[320];
  size_t len = serializeJson(doc, buf);
  n.mqtt.publish(n.tEstado, (const uint8_t*)buf, len, true);   // retenido
  Serial.printf("[%s] estado -> %s\n", n.id, buf);
}

// Decide si la marquesina publica en este ciclo. Devuelve el motivo:
//   'f' forzado por comando, 'p' periódico (banda muerta desactivada),
//   'c' cambio mayor que el umbral, 'l' latido, o 0 si no publica.
// Temperatura y HR solo se comparan si hay lectura válida ahora y en la última publicada;
// que el DHT22 falle o se recupere también cuenta como cambio.
char motivoPublicacion(Nodo& n, bool dhtOk, float temp, float hr, float lux, float co) {
  if (n.forzar)            return 'f';
  if (!n.banda)            return 'p';
  if (!n.hayPrevio)        return 'c';
  if (dhtOk != n.pDhtOk)   return 'c';
  if (dhtOk && (fabsf(temp - n.pTemp) >= n.umbralTemp || fabsf(hr - n.pHr) >= n.umbralHr)) return 'c';
  float cambioLuzPct = fabsf(lux - n.pLux) * 100.0f / max(n.pLux, 10.0f);
  if (cambioLuzPct >= n.umbralLuzPct || fabsf(co - n.pCo) >= n.umbralCo) return 'c';
  if (millis() - n.ultimoEnvio >= n.latidoMs) return 'l';
  return 0;
}

void publicarTelemetria(Nodo& n, uint8_t indice, const Lectura& l) {
  const Desfase& d = DESFASES[indice];
  float temp = l.temp + d.temp + (indice ? ruido(RUIDO_TEMP) : 0);
  float hr   = constrain(l.hr + d.hr + (indice ? ruido(RUIDO_HR) : 0), 0.0f, 100.0f);
  float lux  = l.lux * d.factorLux;
  float co   = max(l.co + d.co, 0.0f);

  char motivo = motivoPublicacion(n, l.dhtOk, temp, hr, lux, co);
  if (!motivo) return;

  JsonDocument doc;
  doc["id"]  = n.id;
  doc["ts"]  = marcaTiempoMs();
  doc["seq"] = ++n.seq;
  if (l.dhtOk) {
    doc["temp"] = redondear(temp, 1);
    doc["hr"]   = redondear(hr, 1);
  } else {
    doc["temp"] = nullptr;
    doc["hr"]   = nullptr;
  }
  doc["lux"]  = (int)lux;
  doc["co"]   = redondear(co, 1);
  doc["rssi"] = WiFi.RSSI();
  doc["m"]    = String(motivo);

  char buf[256];
  size_t len = serializeJson(doc, buf);
  bool ok = n.mqtt.publish(n.tTelemetria, (const uint8_t*)buf, len, false);
  if (ok) {
    n.enviados++;
    n.bytes += len;
    n.ultimoEnvio = millis();
    n.forzar = false;
    n.hayPrevio = true;
    n.pDhtOk = l.dhtOk;
    if (l.dhtOk) { n.pTemp = temp; n.pHr = hr; }
    n.pLux = lux;
    n.pCo  = co;
  }
  Serial.printf("[%s] telemetria (%s) -> %s\n", n.id, ok ? "ok" : "ERROR", buf);
}

// ============================================================================
// Comandos (cafe/<id>/cmd). Afectan solo a esa marquesina, salvo "periodo" y "reiniciar".
//   {"cmd":"leer_ahora"}
//   {"cmd":"banda","activa":true,"temp":0.3,"hr":1.0,"luz_pct":15,"co":5}
//   {"cmd":"latido","valor":300}            (segundos, 30 a 3600)
//   {"cmd":"periodo","valor":10}            (segundos, 2 a 600; muestreo del montaje)
//   {"cmd":"estado"}
//   {"cmd":"calibrar_mq7"}                  (ejecutar en aire limpio)
//   {"cmd":"reiniciar"}
// ============================================================================
void alRecibir(char* topic, byte* payload, unsigned int len) {
  Nodo* n = nullptr;
  for (auto& x : nodos) if (strcmp(topic, x.tCmd) == 0) n = &x;
  if (!n) return;

  JsonDocument doc;
  if (deserializeJson(doc, payload, len)) {
    Serial.printf("[%s] comando con JSON inválido\n", n->id);
    return;
  }
  const char* cmd = doc["cmd"] | "";
  Serial.printf("[%s] comando: %s\n", n->id, cmd);

  if (strcmp(cmd, "leer_ahora") == 0) {
    n->forzar = true;
    ultimaLectura = 0;
  } else if (strcmp(cmd, "banda") == 0) {
    n->banda        = doc["activa"]  | n->banda;
    n->umbralTemp   = doc["temp"]    | n->umbralTemp;
    n->umbralHr     = doc["hr"]      | n->umbralHr;
    n->umbralLuzPct = doc["luz_pct"] | n->umbralLuzPct;
    n->umbralCo     = doc["co"]      | n->umbralCo;
    publicarEstado(*n);
  } else if (strcmp(cmd, "latido") == 0) {
    long s = doc["valor"] | 300;
    n->latidoMs = (unsigned long)constrain(s, 30L, 3600L) * 1000UL;
    publicarEstado(*n);
  } else if (strcmp(cmd, "periodo") == 0) {
    long s = doc["valor"] | 10;
    periodoMs = (unsigned long)constrain(s, 2L, 600L) * 1000UL;
    publicarEstado(*n);
  } else if (strcmp(cmd, "estado") == 0) {
    publicarEstado(*n);
  } else if (strcmp(cmd, "calibrar_mq7") == 0) {
    float v = leerMilivoltios(PIN_MQ7, 64) * MQ7_FACTOR_DIVISOR / 1000.0f;
    // En aire limpio Rs/R0 ≈ 27 según la curva de la hoja de datos del MQ-7
    mq7_R0 = mq7Resistencia(v) / 27.0f;
    publicarEstado(*n);
  } else if (strcmp(cmd, "reiniciar") == 0) {
    delay(300);
    ESP.restart();
  }
}

// ============================================================================
// Conectividad WiFi
// ============================================================================
// Potencia de transmisión reducida: muchas placas ESP32-C3 Super Mini no logran
// asociarse a máxima potencia por el diseño de su antena. Si la señal es débil,
// pruebe WIFI_POWER_11dBm o WIFI_POWER_15dBm.
#define WIFI_TX_POWER  WIFI_POWER_11dBm   // 8,5 dBm no alcanzaba el AP de la Raspberry (-80 dBm)
const unsigned long WIFI_TIMEOUT_MS = 20000;
unsigned long inicioWiFi = 0;

const char* motivoDesconexion(uint8_t r) {
  switch (r) {
    case WIFI_REASON_NO_AP_FOUND:            return "no encuentra la red (SSID o banda 5 GHz)";
    case WIFI_REASON_AUTH_FAIL:              return "falla de autenticación (clave)";
    case WIFI_REASON_4WAY_HANDSHAKE_TIMEOUT:
    case WIFI_REASON_HANDSHAKE_TIMEOUT:      return "clave incorrecta o señal débil (handshake)";
    case WIFI_REASON_AUTH_EXPIRE:            return "autenticación expiró (señal débil)";
    case WIFI_REASON_ASSOC_FAIL:             return "asociación rechazada por el punto de acceso";
    case WIFI_REASON_BEACON_TIMEOUT:         return "se perdió la señal del punto de acceso";
    default:                                 return "otro";
  }
}

void eventoWiFi(WiFiEvent_t evento, WiFiEventInfo_t info) {
  if (evento == ARDUINO_EVENT_WIFI_STA_DISCONNECTED) {
    uint8_t r = info.wifi_sta_disconnected.reason;
    Serial.printf("[WiFi] Desconectado, motivo %u: %s\n", r, motivoDesconexion(r));
  } else if (evento == ARDUINO_EVENT_WIFI_STA_GOT_IP) {
    Serial.printf("[WiFi] Conectado. IP %s  RSSI %d dBm  canal %d\n",
                  WiFi.localIP().toString().c_str(), WiFi.RSSI(), WiFi.channel());
  }
}

// Diagnóstico: lista las redes visibles y dice si aparece la configurada.
void escanearRedes() {
  Serial.println(F("[WiFi] Buscando redes..."));
  int n = WiFi.scanNetworks();
  bool encontrada = false;
  for (int i = 0; i < n; i++) {
    bool es = WiFi.SSID(i) == WIFI_SSID;
    encontrada |= es;
    Serial.printf("  %s %-24s %4d dBm  canal %2d%s\n", es ? ">>" : "  ",
                  WiFi.SSID(i).c_str(), WiFi.RSSI(i), WiFi.channel(i),
                  WiFi.encryptionType(i) == WIFI_AUTH_OPEN ? "  abierta" : "");
  }
  if (!encontrada) {
    Serial.printf("[WiFi] La red \"%s\" NO aparece: revise el nombre (mayúsculas) y que emita en 2,4 GHz\n", WIFI_SSID);
  }
  WiFi.scanDelete();
}

// Inicia la conexión una sola vez y la reintenta solo tras el tiempo de espera.
// Llamar a WiFi.begin() mientras la estación ya está conectándose produce
// "wifi:sta is connecting, return error".
void conectarWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;
  if (inicioWiFi != 0 && millis() - inicioWiFi < WIFI_TIMEOUT_MS) return;
  if (inicioWiFi != 0) {
    Serial.println(F("[WiFi] Sin conexión; se reintentará"));
    WiFi.disconnect(true);
    delay(200);
    WiFi.mode(WIFI_STA);
    WiFi.setTxPower(WIFI_TX_POWER);
  }
  Serial.printf("[WiFi] Conectando a %s\n", WIFI_SSID);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  inicioWiFi = millis();
}

void iniciarWiFi() {
  WiFi.onEvent(eventoWiFi);
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(false);    // la reconexión la controla conectarWiFi()
  WiFi.setTxPower(WIFI_TX_POWER);
  escanearRedes();
  conectarWiFi();
  while (WiFi.status() != WL_CONNECTED && millis() - inicioWiFi < WIFI_TIMEOUT_MS) {
    delay(250);
  }
}

// ============================================================================
// Conectividad MQTT/TLS: un intento por vez y por turnos, para no bloquear el
// loop con tres saludos TLS seguidos.
// ============================================================================
bool conectarMQTT(Nodo& n) {
  char lwt[80];
  snprintf(lwt, sizeof(lwt), "{\"id\":\"%s\",\"estado\":\"offline\"}", n.id);
  char clientId[40];
  snprintf(clientId, sizeof(clientId), "%s-%04X", n.id, (uint16_t)(ESP.getEfuseMac() >> 32));

  Serial.printf("[%s] Conectando a %s:%d (TLS) ... ", n.id, MQTT_HOST, MQTT_PORT);
  uint32_t heapAntes = ESP.getFreeHeap();
  if (n.mqtt.connect(clientId, n.usuario, n.clave, n.tEstado, 1, true, lwt)) {
    Serial.printf("conectado. Heap libre %u B (esta conexión usó ~%d B)\n",
                  ESP.getFreeHeap(), (int)heapAntes - (int)ESP.getFreeHeap());
    n.mqtt.subscribe(n.tCmd, 1);
    publicarEstado(n);
    fallosSeguidos = 0;
    return true;
  }
  char error[100] = "";
  n.red.lastError(error, sizeof(error));
  Serial.printf("falló (rc=%d) %s\n", n.mqtt.state(), error);
  // La estación puede quedar asociada al punto de acceso sin tráfico real (p. ej. tras
  // un corte de radio): WiFi.status() sigue en WL_CONNECTED y nada vuelve a conectar.
  if (++fallosSeguidos >= FALLOS_REINICIO_WIFI) {
    Serial.println(F("[WiFi] Demasiados fallos MQTT seguidos: se fuerza la reconexión WiFi"));
    fallosSeguidos = 0;
    WiFi.disconnect();
    inicioWiFi = millis() - WIFI_TIMEOUT_MS;   // conectarWiFi() reinicia la estación ya
  }
  return false;
}

void atenderConexiones() {
  if (WiFi.status() != WL_CONNECTED || millis() - ultimoIntento < 3000) return;
  for (uint8_t k = 0; k < 3; k++) {
    Nodo& n = nodos[(siguienteNodo + k) % 3];
    if (!n.mqtt.connected()) {
      ultimoIntento = millis();
      siguienteNodo = (siguienteNodo + k + 1) % 3;
      conectarMQTT(n);
      return;
    }
  }
}

// ============================================================================
void setup() {
  Serial.begin(115200);
  delay(1500);
  Serial.printf("\n=== Marquesinas de café — ESP32-C3 — fw %s — modo %s ===\n", FW_VERSION, MODO);
  if (!CA_BROKER) {
    Serial.println(F("[TLS] Falta ca_fog.h (CA de la finca). Sin ella no se conecta al NanoMQ."));
  }

  analogReadResolution(12);
  analogSetAttenuation(ADC_11db);     // rango ~0-3,1 V
  dht.begin();

  Wire.begin(PIN_SDA, PIN_SCL);
  rtcOk = rtc.begin(&Wire);
  Serial.printf("[RTC] DS3231 %s\n", rtcOk ? "detectado" : "NO detectado");

  const char* ids[3]      = { "marquesina-01", "marquesina-02", "marquesina-03" };
  const char* usuarios[3] = { MQTT_USER_01, MQTT_USER_02, MQTT_USER_03 };
  const char* claves[3]   = { MQTT_PASS_01, MQTT_PASS_02, MQTT_PASS_03 };
  for (uint8_t i = 0; i < 3; i++) {
    Nodo& n = nodos[i];
    n.id = ids[i];
    n.usuario = usuarios[i];
    n.clave = claves[i];
    snprintf(n.tTelemetria, sizeof(n.tTelemetria), TOPIC_RAIZ "%s/telemetria", n.id);
    snprintf(n.tEstado,     sizeof(n.tEstado),     TOPIC_RAIZ "%s/estado",     n.id);
    snprintf(n.tCmd,        sizeof(n.tCmd),        TOPIC_RAIZ "%s/cmd",        n.id);
    if (CA_BROKER) n.red.setCACert(CA_BROKER);   // verifica el certificado del broker
    n.red.setHandshakeTimeout(20);
    n.mqtt.setClient(n.red);
    n.mqtt.setServer(MQTT_HOST, MQTT_PORT);
    n.mqtt.setCallback(alRecibir);
    n.mqtt.setBufferSize(512);
    n.mqtt.setKeepAlive(60);
    n.mqtt.setSocketTimeout(20);
  }

  iniciarHora();
  iniciarWiFi();
  Serial.printf("[MEM] Heap libre antes de TLS: %u B\n", ESP.getFreeHeap());
  Serial.println(F("[Sensores] El MQ-7 requiere ~2 min de precalentamiento para estabilizar"));
}

void loop() {
  conectarWiFi();   // no bloquea: solo reintenta si venció el tiempo de espera
  ajustarRTCdesdeNTP();
  if (CA_BROKER) atenderConexiones();
  for (auto& n : nodos) n.mqtt.loop();

  if (millis() - ultimaLectura >= periodoMs || ultimaLectura == 0) {
    ultimaLectura = millis();
    if (!horaConfiable()) {
      Serial.println(F("[Hora] Esperando NTP (o 60 s con el DS3231): aún no se publica"));
      return;
    }
    Lectura l = leerSensores();
    for (uint8_t i = 0; i < 3; i++) {
      if (nodos[i].mqtt.connected()) publicarTelemetria(nodos[i], i, l);
    }
  }
  delay(10);
}
