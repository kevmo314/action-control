#include "stream_screen.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
int main(void) {
    AcStreamScreen s={.severity=99};
    assert(ac_stream_screen_parse("AC-SRT/1\n2\nSRT LIVE\nSEND 2.3\nRTT 4\n1080p\nEIS HS\nMIC\nOK\n",&s));
    assert(s.severity==2 && !strcmp(s.lines[0],"SRT LIVE"));
    const char *bad[]={"", "AC-SRT/2\n", "AC-SRT/1\n9\na\nb\nc\nd\ne\nf\ng\n", "AC-SRT/1\n2\na\nb\nc\nd\ne\nf\ng", "AC-SRT/1\n2\na\nb\nc\nd\ne\nf\ng\ntrailing", "AC-SRT/1\n2\na\nb\nc\nd\ne\nf\n\033\n"};
    for(unsigned i=0;i<sizeof(bad)/sizeof(*bad);i++) {
        s.severity=99;assert(!ac_stream_screen_parse(bad[i],&s));assert(s.severity==99);
    }
    char too_long[256];snprintf(too_long,sizeof(too_long),"AC-SRT/1\n2\n%049d\nb\nc\nd\ne\nf\ng\n",0);
    assert(!ac_stream_screen_parse(too_long,&s));
    puts("stream screen parser checks passed");
}
