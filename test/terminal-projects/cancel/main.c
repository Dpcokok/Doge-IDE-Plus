#include <stdio.h>

int main(void) {
    int choice;
    printf("输入 1 测试等待输入时停止，输入 2 测试死循环停止：");
    if (scanf("%d", &choice) != 1) return 0;
    if (choice == 2) { printf("正在循环，请点停止\n"); for (;;) {} }
    printf("正在等待输入，请点停止：");
    scanf("%d", &choice);
    return 0;
}
