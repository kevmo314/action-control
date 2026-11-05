#ifndef AC_STREAM_SCREEN_H
#define AC_STREAM_SCREEN_H
#define AC_STREAM_ROWS 7
#define AC_STREAM_COLUMNS 49
typedef struct {
    int severity;
    unsigned sequence;
    char lines[AC_STREAM_ROWS][AC_STREAM_COLUMNS];
} AcStreamScreen;
int ac_stream_screen_parse(const char *body,AcStreamScreen *out);
int ac_stream_screen_snapshot(AcStreamScreen *out);
#endif
