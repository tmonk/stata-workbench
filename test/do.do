sysuse auto, clear
reg price mpg
twoway scatter price mpg, name(scatter1, replace)
twoway scatter mpg price