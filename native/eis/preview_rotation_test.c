#include <assert.h>
#include "preview_rotation.c"
static void *expected_session=(void *)(uintptr_t)0x12340;
static uint8_t expected_value;
static int calls;
static int32_t capture(MetadataInfo *info) {
    assert(info->size==56 && info->session==expected_session && info->count==1);
    assert(info->tags[0]==0x84b70020u);
    assert(info->data[0].size==48 && info->data[0].request==0);
    assert(info->data[0].count==1 && info->data[0].offset==0 && info->data[0].negate==0);
    assert(*(const uint8_t *)info->data[0].data==expected_value);
    ++calls;return 7;
}
static uint8_t fake_mode, fake_current;
static int have_mode=1,have_current=1;
static int32_t forward(void *request) {(void)request;return 42;}
static void *metadata(uint64_t request,uint32_t tag,uint32_t type,void *api,void *session,uint32_t camera) {
    assert(type==2 && api==interface_copy && session==expected_session && camera==0);
    if(tag==STEADY_TAG) {assert(request==0x1122334455667788ull);return have_mode?&fake_mode:NULL;}
    assert(tag==ROTATION_TAG && request==0);return have_current?&fake_current:NULL;
}
int main(void) {
    for(uint8_t value=0;value<=1;value++) {
        expected_value=value;
        assert(publish_rotation(capture,expected_session,value)==7);
    }
    assert(calls==2);
    unsigned char node[64]={0},request[104]={0};
    uint32_t size=sizeof(request);uint64_t frame=0x1122334455667788ull;
    void *n=node;SetMetadataFn set=capture;
    memcpy(node+48,&expected_session,sizeof(expected_session));
    memcpy(request,&size,sizeof(size));memcpy(request+8,&n,sizeof(n));memcpy(request+16,&frame,sizeof(frame));
    memcpy(interface_copy+32,&set,sizeof(set));
    atomic_store(&interface_ready,1);get_metadata=metadata;original_process=forward;
    for(uint8_t mode=0;mode<=7;mode++) {
        fake_mode=mode;expected_value=(mode==3 || mode==6);fake_current=!expected_value;
        int before=calls;assert(process_request(request)==42);
        int supported=(mode==0 || mode==2 || mode==3 || mode==5 || mode==6);
        assert(calls-before==supported);
        fake_current=expected_value;before=calls;
        assert(process_request(request)==42 && calls==before);
    }
    /* A missing usecase flag must be initialized, including when switching
       back to RockSteady (false); it is different from an existing zero. */
    have_current=0;
    for(uint8_t mode=2;mode<=3;mode++) {
        fake_mode=mode;expected_value=(mode==3);
        int before=calls;assert(process_request(request)==42 && calls==before+1);
    }
    have_current=1;
    have_mode=0;int before=calls;
    assert(process_request(request)==42 && calls==before);
    atomic_store(&interface_ready,0);
    assert(process_request(request)==42 && calls==before);
    return 0;
}
