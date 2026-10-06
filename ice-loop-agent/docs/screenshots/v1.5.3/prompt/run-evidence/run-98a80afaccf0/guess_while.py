# 答案固定为 7，猜对就停
answer = 7
guess = 0
# 条件不成立时，循环自动结束
while guess != answer:
    guess = int(input("猜一个 1-10 的整数："))
    if guess != answer:
        print("再试一次")
    else:
        print("猜对了")
