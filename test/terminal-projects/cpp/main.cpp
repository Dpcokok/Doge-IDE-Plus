#include <iostream>
#include <string>

int main() {
    std::string name;
    int age;
    std::cout << "你的名字：";
    std::getline(std::cin, name);
    std::cout << "你的年龄：";
    if (!(std::cin >> age)) return 1;
    std::cout << "你好，" << name << "，年龄 " << age << '\n';
    std::cout << "输入数字，发送 EOF 结束：\n";
    while (std::cin >> age) std::cout << "收到：" << age << '\n';
    std::cout << "EOF 已收到\n";
    return 0;
}
