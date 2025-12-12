from ultralytics import YOLO

model = YOLO("C:/Users/ShonithDraksharam/PycharmProjects/pythonProject/models/best (3).pt")
print(model.names)
