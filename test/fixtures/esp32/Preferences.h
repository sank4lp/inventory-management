#pragma once
#include <string.h>
#include <vector>
struct Preferences {
  inline static std::vector<unsigned char> saved;
  inline static bool failWrite = false;
  inline static bool failOpen = false;
  inline static int writes = 0;
  bool begin(const char *,bool) { return !failOpen; }
  size_t getBytesLength(const char *) { return saved.size(); }
  size_t getBytes(const char *,void *data,size_t length) { if(saved.size()!=length)return 0; memcpy(data,saved.data(),length);return length; }
  size_t putBytes(const char *,const void *data,size_t length) { if(failWrite)return 0; const unsigned char *p=(const unsigned char*)data;saved.assign(p,p+length);writes++;return length; }
};
