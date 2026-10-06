# 外层循环管行，内层循环管列
for row in range(1, 10):
    line = ""
    for col in range(1, row + 1):
        # \t 让每一列对齐
        line += f"{col}×{row}={row * col}\t"
    print(line)
