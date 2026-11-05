#include "stream_screen.h"
#include <string.h>

/* Reject truncated/oversized/control-bearing responses. Caller publishes only
   complete snapshots, so a partial HTTP response cannot leave a false LIVE. */
int ac_stream_screen_parse(const char *body,AcStreamScreen *out) {
    if(strncmp(body,"AC-SRT/1\n",9))return 0;
    const char *p=body+9;
    if(p[0]<'0'||p[0]>'3'||p[1]!='\n')return 0;
    AcStreamScreen result={.severity=p[0]-'0'};
    p+=2;
    for(int row=0;row<AC_STREAM_ROWS;row++) {
        const char *end=strchr(p,'\n');
        if(!end || (size_t)(end-p)>=AC_STREAM_COLUMNS)return 0;
        for(const char *at=p;at<end;at++)if((unsigned char)*at<32 || (unsigned char)*at>126)return 0;
        memcpy(result.lines[row],p,(size_t)(end-p));
        p=end+1;
    }
    if(*p)return 0;
    *out=result;
    return 1;
}
