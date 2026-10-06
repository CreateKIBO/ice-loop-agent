# range(1, 6) 依次取出 1 到 5
for i in range(1, 6):
    print(f"第 {i} 次循环")

# total 先归零，再一点点累加
total = 0
for n in range(1, 6):
    total += n
print("1 到 5 的和是", total)
