#define _GNU_SOURCE
#include "../gui/sha256.h"
#include <dlfcn.h>
#include <pthread.h>
#include <stdint.h>
#include <stdatomic.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>

/* AC204-only adapter. These layouts and offsets were recovered from the exact
 * stock modules fingerprinted below. No image pixels or orientation angles are
 * changed here. This mirrors the recording node's usecase metadata publication.
 */
#define ORIGINAL "/run/action-control-eis-rotation/original-eis-preview.so"
#define ORIGINAL_HASH "c14c9d440dc2a006503d4b3a0807b5ba4d3ee43a40edeb8d6e6f8fd13dbb8c14"
#define CAMERA_HAL "/usr/lib/hw/camera.qcom.so"
#define CAMERA_HAL_HASH "0439c2b5cc867ec914bc16d8ce85a49f6b849822abae780fae149133b3bb5953"
#define NODE_UTILS "/usr/lib/libcom.qti.chinodeutils.so"
#define NODE_UTILS_HASH "00df8ce9ae1ca9b5f3a13396515ad9e5fa022ee9cf63b22fc84a628868ba6572"
#define STEADY_TAG 0x88b7001au
#define ROTATION_TAG 0x84b70020u

typedef struct {
    uint32_t size, reserved;
    uint64_t request;
    const void *data;
    uint64_t count, offset, negate;
} TagData;
typedef struct {
    uint32_t size, reserved;
    void *session;
    uint32_t count, reserved2;
    uint32_t *tags;
    TagData *data;
    uint64_t reserved3, reserved4;
} MetadataInfo;
_Static_assert(sizeof(TagData)==48,"stock tag ABI");
_Static_assert(offsetof(TagData,data)==16,"stock tag payload");
_Static_assert(sizeof(MetadataInfo)==56,"stock metadata ABI");
_Static_assert(offsetof(MetadataInfo,tags)==24,"stock metadata tags");

typedef int32_t (*ProcessFn)(void *);
typedef void (*InterfaceFn)(void *);
typedef int32_t (*SetMetadataFn)(MetadataInfo *);
typedef void *(*GetMetadataFn)(uint64_t,uint32_t,uint32_t,void *,void *,uint32_t);
static void (*original_entry)(void *);
static ProcessFn original_process;
static InterfaceFn original_interface;
static GetMetadataFn get_metadata;
static unsigned char interface_copy[512] __attribute__((aligned(16)));
static _Atomic int interface_ready;
static _Atomic unsigned int diagnostic_count;
static pthread_once_t once=PTHREAD_ONCE_INIT;
static pthread_mutex_t setup_lock=PTHREAD_MUTEX_INITIALIZER;

static uint32_t u32(const void *p,size_t offset) {
    uint32_t out;memcpy(&out,(const char *)p+offset,sizeof(out));return out;
}
static uint64_t u64(const void *p,size_t offset) {
    uint64_t out;memcpy(&out,(const char *)p+offset,sizeof(out));return out;
}
static void *pointer(const void *p,size_t offset) {
    void *out;memcpy(&out,(const char *)p+offset,sizeof(out));return out;
}

/* Kept small and independently testable: construct exactly the same usecase
 * publication that ChiDjiEISNode performs for HorizonSteady/HorizonBalancing. */
static int32_t publish_rotation(SetMetadataFn set,void *session,uint8_t enabled) {
    uint32_t tag=ROTATION_TAG;
    TagData data={.size=sizeof(data),.data=&enabled,.count=1};
    MetadataInfo metadata={.size=sizeof(metadata),.session=session,.count=1,.tags=&tag,.data=&data};
    return set(&metadata);
}

static void load_original(void) {
    char hash[65];
    if(ac_sha256_file(ORIGINAL,hash) || strcmp(hash,ORIGINAL_HASH)) {
        fprintf(stderr,"osmo-eis-rotation: original module fingerprint rejected\n");return;
    }
    void *library=dlopen(ORIGINAL,RTLD_NOW|RTLD_LOCAL|RTLD_DEEPBIND|RTLD_NODELETE);
    if(!library){fprintf(stderr,"osmo-eis-rotation: original module failed to load\n");return;}
    void *symbol=dlsym(library,"ChiNodeEntry");memcpy(&original_entry,&symbol,sizeof(symbol));
    /* The HAL assigns the private vendor tag numbers. If it differs, retain
       the stock factory without interposing either callback. */
    if(ac_sha256_file(CAMERA_HAL,hash) || strcmp(hash,CAMERA_HAL_HASH)) {
        fprintf(stderr,"osmo-eis-rotation: HAL fingerprint rejected; stock callbacks retained\n");return;
    }
    if(ac_sha256_file(NODE_UTILS,hash) || strcmp(hash,NODE_UTILS_HASH)) {
        fprintf(stderr,"osmo-eis-rotation: node utility fingerprint rejected; stock callbacks retained\n");return;
    }
    symbol=dlsym(library,"_ZN12ChiNodeUtils11GetMetaDataEmj15ChiMetadataTypeP16ChiNodeInterfacePvj");
    memcpy(&get_metadata,&symbol,sizeof(symbol));
}

static void set_interface(void *api) {
    original_interface(api);
    /* The inspected stock SetNodeInterface rejects tables smaller than 384. */
    if(!api || u32(api,0)<384 || u32(api,0)>sizeof(interface_copy))return;
    pthread_mutex_lock(&setup_lock);
    if(!atomic_load_explicit(&interface_ready,memory_order_relaxed)) {
        memcpy(interface_copy,api,u32(api,0));
        atomic_store_explicit(&interface_ready,1,memory_order_release);
    }
    pthread_mutex_unlock(&setup_lock);
}

static int32_t process_request(void *request) {
    /* The original entry requires a 104-byte request and a valid node object.
       A valid object from this exact firmware stores hChiSession at byte 48. */
    if(request && u32(request,0)>=104 && pointer(request,8) && atomic_load_explicit(&interface_ready,memory_order_acquire) && get_metadata) {
        void *node=pointer(request,8),*session=pointer(node,48);
        if(session) {
            uint64_t frame=u64(request,16);
            const uint8_t *mode=get_metadata(frame,STEADY_TAG,2,interface_copy,session,0);
            if(mode && (*mode==0 || *mode==2 || *mode==3 || *mode==5 || *mode==6)) {
                uint8_t selected=*mode;
                uint8_t enabled=(selected==3 || selected==6);
                const uint8_t *current=get_metadata(0,ROTATION_TAG,2,interface_copy,session,0);
                if(!current || *current!=enabled) {
                    void *symbol=pointer(interface_copy,32);
                    SetMetadataFn set;memcpy(&set,&symbol,sizeof(set));
                    if(set) {
                        int32_t result=publish_rotation(set,session,enabled);
                        if(atomic_fetch_add_explicit(&diagnostic_count,1,memory_order_relaxed)<64)
                        fprintf(stderr,"osmo-eis-rotation: frame=%llu mode=%u IPE=%u result=%d\n",
                            (unsigned long long)frame,selected,enabled,result);
                    }
                }
            }
        }
    }
    return original_process(request);
}

__attribute__((visibility("default")))
void ChiNodeEntry(void *callbacks) {
    pthread_once(&once,load_original);
    if(!original_entry || !callbacks)return;
    original_entry(callbacks);
    /* Entry version 0 uses a 240-byte callback table, process at 64, interface
       at 72. Every unrelated callback and the original lifetime remain intact. */
    if(u32(callbacks,0)<240 || u32(callbacks,4)!=0 || !get_metadata)return;
    pthread_mutex_lock(&setup_lock);
    void *p=pointer(callbacks,64),*i=pointer(callbacks,72);
    if(p && i) {
        memcpy(&original_process,&p,sizeof(p));memcpy(&original_interface,&i,sizeof(i));
        ProcessFn process=process_request;InterfaceFn set=set_interface;
        memcpy((char *)callbacks+64,&process,sizeof(process));
        memcpy((char *)callbacks+72,&set,sizeof(set));
    }
    pthread_mutex_unlock(&setup_lock);
}
