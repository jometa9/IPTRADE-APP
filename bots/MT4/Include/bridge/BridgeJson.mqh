#property strict

int BridgeJsonSkipWhitespace(const string text, int pos) {
   int len = StringLen(text);
   while(pos < len) {
      int ch = StringGetCharacter(text, pos);
      if(ch == ' ' || ch == '\t' || ch == '\n' || ch == '\r') {
         pos++;
      } else {
         break;
      }
   }
   return pos;
}

int BridgeJsonFindKey(const string json, const string key) {
   string needle = "\"" + key + "\"";
   return StringFind(json, needle);
}

string BridgeJsonExtractQuoted(const string json, int pos, bool &ok) {
   ok = false;
   int len = StringLen(json);
   if(pos >= len || StringGetCharacter(json, pos) != '"')
      return "";

   pos++;
   string result = "";
   while(pos < len) {
      int ch = StringGetCharacter(json, pos);
      if(ch == '\\') {
         pos++;
         if(pos >= len) break;
         ch = StringGetCharacter(json, pos);
         if(ch >= 0 && ch <= 255) {
            result += CharToString((uchar)(ch & 0xFF));
         }
      } else if(ch == '"') {
         ok = true;
         return result;
      } else {
         if(ch >= 0 && ch <= 255) {
            result += CharToString((uchar)(ch & 0xFF));
         }
      }
      pos++;
   }
   return result;
}

string BridgeJsonGetString(const string json, const string key, const string def="") {
   int pos = BridgeJsonFindKey(json, key);
   if(pos < 0) return def;

   pos = StringFind(json, ":", pos);
   if(pos < 0) return def;
   pos = BridgeJsonSkipWhitespace(json, pos + 1);


   int len = StringLen(json);
   if(pos >= len) return def;

   int ch = StringGetCharacter(json, pos);
   if(ch != '"') {

      return def;
   }

   bool ok = false;
   string value = BridgeJsonExtractQuoted(json, pos, ok);
   return ok ? value : def;
}

double BridgeJsonGetDouble(const string json, const string key, double def=0.0) {
   int pos = BridgeJsonFindKey(json, key);
   if(pos < 0) return def;
   pos = StringFind(json, ":", pos);
   if(pos < 0) return def;
   pos = BridgeJsonSkipWhitespace(json, pos + 1);

   int len = StringLen(json);
   string value = "";
   while(pos < len) {
      int ch = StringGetCharacter(json, pos);
      if((ch >= '0' && ch <= '9') || ch == '-' || ch == '+' || ch == '.' || ch == 'e' || ch == 'E') {
         if(ch >= 0 && ch <= 255) {
            value += CharToString((uchar)(ch & 0xFF));
         }
      } else {
         break;
      }
      pos++;
   }
   if(StringLen(value) == 0) return def;
   return StringToDouble(value);
}

long BridgeJsonGetLong(const string json, const string key, long def=0) {
   return (long)BridgeJsonGetDouble(json, key, def);
}

bool BridgeJsonGetBool(const string json, const string key, bool def=false) {
   int pos = BridgeJsonFindKey(json, key);
   if(pos < 0) return def;
   pos = StringFind(json, ":", pos);
   if(pos < 0) return def;
   pos = BridgeJsonSkipWhitespace(json, pos + 1);
   int tailLen = 5;
   string tail = StringSubstr(json, pos, tailLen);
   string lower = tail;
   StringToLower(lower);
   if(StringFind(lower, "true") == 0) return true;
   if(StringFind(lower, "false") == 0) return false;
   return def;
}

string BridgeJsonGetObject(const string json, const string key) {
   int pos = BridgeJsonFindKey(json, key);
   if(pos < 0) return "";
   pos = StringFind(json, ":", pos);
   if(pos < 0) return "";
   pos = BridgeJsonSkipWhitespace(json, pos + 1);
   if(pos >= StringLen(json)) return "";

   int startChar = StringGetCharacter(json, pos);
   if(startChar != '{' && startChar != '[')
      return "";

   int depth = 0;
   bool inString = false;
   int len = StringLen(json);
   int closeChar = (startChar == '{') ? '}' : ']';
   int i;
   for(i = pos; i < len; i++) {
      int ch = StringGetCharacter(json, i);
      if(ch == '"' && (i == 0 || StringGetCharacter(json, i - 1) != '\\')) {
         inString = !inString;
      }
      if(inString) continue;

      if(ch == startChar) depth++;
      if(ch == closeChar) {
         depth--;
         if(depth == 0) {
            return StringSubstr(json, pos, i - pos + 1);
         }
      }
   }
   return "";
}

int BridgeJsonArrayLength(const string arrayStr) {
   int len = StringLen(arrayStr);
   int pos = 0;
   while(pos < len && (StringGetCharacter(arrayStr, pos) == ' ' || StringGetCharacter(arrayStr, pos) == '\t' || StringGetCharacter(arrayStr, pos) == '\n' || StringGetCharacter(arrayStr, pos) == '\r')) pos++;
   if(pos >= len || StringGetCharacter(arrayStr, pos) != '[') return 0;
   pos++;
   int count = 0;
   int len2 = len;
   while(pos < len2) {
      while(pos < len2 && (StringGetCharacter(arrayStr, pos) == ' ' || StringGetCharacter(arrayStr, pos) == '\t' || StringGetCharacter(arrayStr, pos) == '\n' || StringGetCharacter(arrayStr, pos) == '\r' || StringGetCharacter(arrayStr, pos) == ',')) pos++;
      if(pos >= len2 || StringGetCharacter(arrayStr, pos) == ']') break;
      if(StringGetCharacter(arrayStr, pos) == '{') {
         count++;
         int depth = 1;
         pos++;
         while(pos < len2 && depth > 0) {
            int ch = StringGetCharacter(arrayStr, pos);
            if(ch == '"' && (pos == 0 || StringGetCharacter(arrayStr, pos - 1) != '\\')) {
               pos++;
               while(pos < len2 && StringGetCharacter(arrayStr, pos) != '"') { if(StringGetCharacter(arrayStr, pos) == '\\') pos++; pos++; }
               if(pos < len2) pos++;
               continue;
            }
            if(ch == '{') depth++;
            else if(ch == '}') depth--;
            pos++;
         }
      } else {
         pos++;
      }
   }
   return count;
}

string BridgeJsonArrayElement(const string arrayStr, int index) {
   int len = StringLen(arrayStr);
   int pos = 0;
   while(pos < len && (StringGetCharacter(arrayStr, pos) == ' ' || StringGetCharacter(arrayStr, pos) == '\t' || StringGetCharacter(arrayStr, pos) == '\n' || StringGetCharacter(arrayStr, pos) == '\r')) pos++;
   if(pos >= len || StringGetCharacter(arrayStr, pos) != '[') return "";
   pos++;
   int current = 0;
   int len2 = len;
   while(pos < len2) {
      while(pos < len2 && (StringGetCharacter(arrayStr, pos) == ' ' || StringGetCharacter(arrayStr, pos) == '\t' || StringGetCharacter(arrayStr, pos) == '\n' || StringGetCharacter(arrayStr, pos) == '\r' || StringGetCharacter(arrayStr, pos) == ',')) pos++;
      if(pos >= len2 || StringGetCharacter(arrayStr, pos) == ']') return "";
      if(StringGetCharacter(arrayStr, pos) == '{') {
         if(current == index) {
            int start = pos;
            int depth = 1;
            pos++;
            while(pos < len2 && depth > 0) {
               int ch = StringGetCharacter(arrayStr, pos);
               if(ch == '"' && (pos == 0 || StringGetCharacter(arrayStr, pos - 1) != '\\')) {
                  pos++;
                  while(pos < len2 && StringGetCharacter(arrayStr, pos) != '"') { if(StringGetCharacter(arrayStr, pos) == '\\') pos++; pos++; }
                  if(pos < len2) pos++;
                  continue;
               }
               if(ch == '{') depth++;
               else if(ch == '}') { depth--; if(depth == 0) return StringSubstr(arrayStr, start, pos - start + 1); }
               pos++;
            }
            return "";
         }
         current++;
         int depth = 1;
         pos++;
         while(pos < len2 && depth > 0) {
            int ch = StringGetCharacter(arrayStr, pos);
            if(ch == '"' && (pos == 0 || StringGetCharacter(arrayStr, pos - 1) != '\\')) {
               pos++;
               while(pos < len2 && StringGetCharacter(arrayStr, pos) != '"') { if(StringGetCharacter(arrayStr, pos) == '\\') pos++; pos++; }
               if(pos < len2) pos++;
               continue;
            }
            if(ch == '{') depth++;
            else if(ch == '}') depth--;
            pos++;
         }
      } else {
         pos++;
      }
   }
   return "";
}

string BridgeJsonQuote(const string value) {
   string result = "\"";
   int len = StringLen(value);
   int i;
   for(i = 0; i < len; i++) {
      int ch = StringGetCharacter(value, i);
      if(ch == '"' || ch == '\\') {
         result += "\\";
      }
      if(ch >= 0 && ch <= 255) {
         result += CharToString((uchar)(ch & 0xFF));
      }
   }
   result += "\"";
   return result;
}






long GetUnixTimestamp() {
   #ifdef __MQL5__
      return (long)TimeCurrent();
   #else

      return (long)TimeCurrent();
   #endif
}


string BuildStandardResponse(bool success, string errorCode, string errorMsg, string dataJson) {
   string response = "{";
   response += "\"success\":" + (success ? "true" : "false") + ",";
   response += "\"error\":";
   if(!success && StringLen(errorCode) > 0) {
      response += "{";
      response += "\"code\":\"" + errorCode + "\",";
      response += "\"message\":\"" + errorMsg + "\"";
      response += "}";
   } else {
      response += "null";
   }
   response += ",";
   response += "\"data\":";
   if(StringLen(dataJson) > 0) {
      response += dataJson;
   } else {
      response += "null";
   }
   response += "}";
   return response;
}


string GetPlatformName() {
   #ifdef __MQL5__
      return "metatrader5";
   #else
      return "metatrader4";
   #endif
}


bool ValidateCreateOrderRequest(string symbol, string type, string side, double volume, string &errorCode, string &errorMsg) {
   if(StringLen(symbol) == 0) {
      errorCode = "INVALID_REQUEST";
      errorMsg = "Symbol is required";
      return false;
   }

   if(StringLen(type) == 0) {
      errorCode = "INVALID_REQUEST";
      errorMsg = "Type is required";
      return false;
   }

   if(StringLen(side) == 0) {
      errorCode = "INVALID_REQUEST";
      errorMsg = "Side is required";
      return false;
   }

   if(volume <= 0) {
      errorCode = "INVALID_VOLUME";
      errorMsg = "Volume must be greater than 0";
      return false;
   }


   if(type != "market" && type != "limit" && type != "stop" && type != "stop_limit") {
      errorCode = "INVALID_REQUEST";
      errorMsg = "Invalid order type: " + type;
      return false;
   }


   if(side != "buy" && side != "sell") {
      errorCode = "INVALID_REQUEST";
      errorMsg = "Invalid order side: " + side;
      return false;
   }

   return true;
}

