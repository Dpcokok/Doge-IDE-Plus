name = input("你的名字：")
age = input("你的年龄：")
print(f"你好，{name}，你输入的年龄是 {age}")
print("输入多行文字，发送 EOF 结束：")
import sys
for line in sys.stdin:
    print("收到：", line.rstrip("\n"))
print("EOF 已收到，程序正常结束")
