#include <stdio.h>

int main(void) {
    int a, b;
    printf("第一个数字：");
    if (scanf("%d", &a) != 1) return 1;
    printf("第二个数字：");
    if (scanf("%d", &b) != 1) return 1;
    printf("和：%d\n", a + b);
    printf("输入更多数字，发送 EOF 结束：\n");
    while (scanf("%d", &a) == 1) printf("收到：%d\n", a);
    printf("EOF 已收到\n");
    return 0;
}
